#pragma once

// ============================================================
//  WebSocketSender   —   minimal RFC 6455 WebSocket CLIENT
//
//  No external libraries needed — uses juce::StreamingSocket
//  (part of juce_core, already linked).
//
//  Threading model:
//    - Audio thread  → calls updateData() only (lock-free write)
//    - Message thread → calls updateData() from timerCallback
//    - Sender thread  → connects, (re)connects, sends at 10 Hz
//
//  Usage:
//    WebSocketSender sender;
//    sender.startSending("127.0.0.1", 8765);
//    // later:
//    sender.updateData("E2", 82.4f, -1.2f, "In Tune!");
// ============================================================

#include <JuceHeader.h>
#include <atomic>
#include <mutex>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <cstring>

class WebSocketSender : private juce::Thread
{
public:
    WebSocketSender()  : juce::Thread ("WSSender") {}
    ~WebSocketSender() { stopThread (3000); }

    // ── Public API (call from any thread) ──────────────────

    void startSending (const juce::String& host = "127.0.0.1", int port = 8765)
    {
        host_ = host;
        port_ = port;
        startThread (juce::Thread::Priority::low);
    }

    /** Thread-safe: store the latest pitch state.
     *  Called from the message thread (timerCallback).
     *  The sender thread picks it up at 10 Hz. */
    void updateData (const juce::String& note,
                     float               frequency,
                     float               cents,
                     const juce::String& status)
    {
        std::lock_guard<std::mutex> lock (mutex_);
        data_.note      = note.toStdString();
        data_.frequency = frequency;
        data_.cents     = cents;
        data_.status    = status.toStdString();
        data_.fresh     = true;
    }

    bool isConnected() const { return connected_.load (std::memory_order_relaxed); }

private:
    // ── Data shared between threads ─────────────────────────

    struct Snapshot
    {
        std::string note      { "--" };
        float       frequency { 0.0f };
        float       cents     { 0.0f };
        std::string status    { "NoSignal" };
        bool        fresh     { false };
    };

    // ── Sender thread ───────────────────────────────────────

    void run() override
    {
        while (!threadShouldExit())
        {
            // (Re)connect if needed, retry every 2 s
            if (!connected_.load())
            {
                if (!doHandshake())
                {
                    wait (2000);
                    continue;
                }
            }

            // ── Poll incoming frames (50 ms) ───────────────────────
            // The Python websockets library sends a ping ~every 20 s.
            // If we ignore it, the server closes the connection.
            // handleIncomingFrames() reads any pending data and
            // responds to PING frames with a PONG frame.
            for (int i = 0; i < 2; ++i)   // run twice per 100 ms cycle
            {
                if (!handleIncomingFrames())
                {
                    connected_ = false;
                    socket_.close();
                    break;
                }
                wait (50);
            }

            if (!connected_.load()) continue;

            // ── Send latest pitch data ────────────────────────────
            Snapshot snap;
            bool hasFresh = false;
            {
                std::lock_guard<std::mutex> lock (mutex_);
                if (data_.fresh)
                {
                    snap     = data_;
                    data_.fresh = false;
                    hasFresh = true;
                }
            }

            if (hasFresh && !sendTextFrame (buildJson (snap)))
            {
                connected_ = false;
                socket_.close();
            }
        }

        socket_.close();
    }

    // ── WebSocket handshake ─────────────────────────────────

    bool doHandshake()
    {
        socket_.close();
        if (!socket_.connect (host_, port_, 3000))
            return false;

        // Build the HTTP upgrade request
        const juce::String key = makeWsKey();
        const juce::String req =
            "GET / HTTP/1.1\r\n"
            "Host: " + host_ + ":" + juce::String (port_) + "\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: " + key + "\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n";

        const auto reqStd = req.toStdString();
        if (!socket_.write (reqStd.c_str(), (int) reqStd.size()))
            return false;

        // Read until we see the end-of-headers marker
        char   buf[2048] {};
        int    total = 0;
        for (int attempt = 0; attempt < 100 && !threadShouldExit(); ++attempt)
        {
            const int n = socket_.read (buf + total,
                                        (int) sizeof (buf) - total - 1,
                                        false /*non-blocking*/);
            if (n > 0)
            {
                total += n;
                buf[total] = '\0';
                if (std::strstr (buf, "\r\n\r\n") != nullptr)
                    break;
            }
            else if (n < 0)
            {
                socket_.close();
                return false;
            }
            wait (10);
        }

        // Verify the server agreed to upgrade (HTTP 101)
        if (std::strstr (buf, "101") == nullptr)
        {
            socket_.close();
            return false;
        }

        connected_ = true;
        return true;
    }

    // ── Incoming frame handler ──────────────────────────────

    /** Read any pending frame from the server (non-blocking poll).
     *  Responds to PING (opcode 9) with a PONG (opcode 10).
     *  Returns false if the server closed the connection. */
    bool handleIncomingFrames()
    {
        // waitUntilReady(true, 0) = non-blocking poll: returns 1=data, 0=empty, -1=error
        const int ready = socket_.waitUntilReady (true, 0);
        if (ready == 0) return true;   // nothing waiting — still healthy
        if (ready <  0) return false;  // socket error

        // Read 2-byte header
        uint8_t header[2];
        if (socket_.read (reinterpret_cast<char*> (header), 2, true) != 2)
            return false;

        const uint8_t opcode     = header[0] & 0x0F;
        const bool    serverMask = (header[1] & 0x80) != 0;
        uint64_t      payloadLen = header[1] & 0x7F;

        // Extended length
        if (payloadLen == 126)
        {
            uint8_t ext[2];
            if (socket_.read (reinterpret_cast<char*> (ext), 2, true) != 2) return false;
            payloadLen = (static_cast<uint64_t> (ext[0]) << 8) | ext[1];
        }
        else if (payloadLen == 127)
        {
            uint8_t ext[8];
            if (socket_.read (reinterpret_cast<char*> (ext), 8, true) != 8) return false;
            payloadLen = 0;
            for (int i = 0; i < 8; ++i)
                payloadLen = (payloadLen << 8) | ext[i];
        }

        // Read payload (unmask if server somehow masked it)
        std::vector<uint8_t> payload (static_cast<size_t> (payloadLen));
        if (payloadLen > 0)
        {
            if (serverMask)
            {
                uint8_t mkey[4];
                if (socket_.read (reinterpret_cast<char*> (mkey), 4, true) != 4) return false;
                if (socket_.read (reinterpret_cast<char*> (payload.data()),
                                  static_cast<int> (payloadLen), true)
                    != static_cast<int> (payloadLen)) return false;
                for (size_t i = 0; i < payload.size(); ++i)
                    payload[i] ^= mkey[i % 4];
            }
            else
            {
                if (socket_.read (reinterpret_cast<char*> (payload.data()),
                                  static_cast<int> (payloadLen), true)
                    != static_cast<int> (payloadLen)) return false;
            }
        }

        if      (opcode == 0x9) return sendControlFrame (0xA, payload); // PING → PONG
        else if (opcode == 0x8) { sendControlFrame (0x8, {}); return false; } // CLOSE

        return true;  // text / binary / continuation → ignore
    }

    /** Send a control frame (PONG=0xA, CLOSE=0x8) with client masking. */
    bool sendControlFrame (uint8_t opcode, const std::vector<uint8_t>& payload)
    {
        jassert (payload.size() <= 125);   // RFC 6455: control frames ≤ 125 bytes
        std::vector<uint8_t> frame;
        frame.push_back (0x80 | opcode);
        frame.push_back (static_cast<uint8_t> (0x80 | payload.size()));
        constexpr uint8_t mk[4] = { 0x11, 0x22, 0x33, 0x44 };
        for (auto b : mk) frame.push_back (b);
        for (size_t i = 0; i < payload.size(); ++i)
            frame.push_back (payload[i] ^ mk[i % 4]);
        return socket_.write (reinterpret_cast<const char*> (frame.data()),
                              static_cast<int> (frame.size()));
    }

    // ── Frame building ──────────────────────────────────────

    /** Send a WebSocket text frame with client-side masking (RFC 6455 §5). */

    bool sendTextFrame (const std::string& payload)
    {
        const size_t len = payload.size();

        std::vector<uint8_t> frame;
        frame.reserve (len + 10);

        // Byte 0: FIN=1, RSV=0, opcode=0x1 (text)
        frame.push_back (0x81);

        // Byte 1: MASK=1, payload length
        if (len < 126)
        {
            frame.push_back (static_cast<uint8_t> (0x80 | len));
        }
        else   // 126 <= len < 65536  (our JSON is always small, but be safe)
        {
            frame.push_back (0xFE);  // 0x80 | 126
            frame.push_back (static_cast<uint8_t> ((len >> 8) & 0xFF));
            frame.push_back (static_cast<uint8_t> (len & 0xFF));
        }

        // 4-byte masking key  (fixed is fine for a local debug stream)
        constexpr uint8_t mask[4] = { 0x37, 0xFA, 0x21, 0x3D };
        frame.push_back (mask[0]);
        frame.push_back (mask[1]);
        frame.push_back (mask[2]);
        frame.push_back (mask[3]);

        // Masked payload
        for (size_t i = 0; i < len; ++i)
            frame.push_back (static_cast<uint8_t> (payload[i]) ^ mask[i % 4]);

        return socket_.write (reinterpret_cast<const char*> (frame.data()),
                              static_cast<int> (frame.size()));
    }

    // ── Helpers ─────────────────────────────────────────────

    /** Build the JSON payload string. */
    static std::string buildJson (const Snapshot& s)
    {
        std::ostringstream ss;
        ss << std::fixed
           << "{\"note\":\""     << s.note                          << "\","
           << "\"frequency\":"   << std::setprecision (1) << s.frequency << ","
           << "\"cents\":"       << std::setprecision (1) << s.cents     << ","
           << "\"status\":\""    << s.status                        << "\"}";
        return ss.str();
    }

    /** Generate a random 16-byte WebSocket handshake key (base64). */
    static juce::String makeWsKey()
    {
        juce::Random rng (juce::Time::getCurrentTime().toMilliseconds());
        uint8_t bytes[16];
        for (auto& b : bytes)
            b = static_cast<uint8_t> (rng.nextInt (256));
        return juce::Base64::toBase64 (bytes, sizeof (bytes));
    }

    std::mutex              mutex_;
    Snapshot                data_;           // protected by mutex_
    std::atomic<bool>       connected_ { false };
    juce::StreamingSocket   socket_;
    juce::String            host_ { "127.0.0.1" };
    int                     port_ { 8765 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebSocketSender)
};
