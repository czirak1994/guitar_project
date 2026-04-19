#pragma once

// ============================================================
//  DebugLogger  —  header-only, debug builds only
//
//  Usage:
//    TONECOACH_LOG_INIT("debug.log")    // call once at startup
//    TONECOACH_LOG("some message")      // message-thread only!
//    TONECOACH_LOG_FLUSH()              // optional, forces disk write
//
//  In Release builds all macros expand to nothing (zero overhead).
//  Call TONECOACH_LOG only from the message thread (timerCallback,
//  prepareToPlay, etc.) — never from the real-time audio callback.
// ============================================================

#if JUCE_DEBUG

#include <JuceHeader.h>
#include <fstream>
#include <mutex>
#include <chrono>
#include <iomanip>
#include <sstream>

class DebugLogger
{
public:
    // ── Singleton access ────────────────────────────────────
    static DebugLogger& getInstance()
    {
        static DebugLogger instance;
        return instance;
    }

    // ── Initialise: open log file, write header ─────────────
    void init (const juce::String& filename, double sampleRate = 0.0)
    {
        const juce::File logFile =
            juce::File::getSpecialLocation (juce::File::userDocumentsDirectory)
                .getChildFile ("ToneCoach")
                .getChildFile (filename);

        logFile.getParentDirectory().createDirectory();

        std::lock_guard<std::mutex> lock (mutex_);
        stream_.open (logFile.getFullPathName().toStdString(),
                      std::ios::out | std::ios::trunc);
        startTime_ = std::chrono::steady_clock::now();

        if (stream_.is_open())
        {
            const auto now = juce::Time::getCurrentTime();

            stream_ << "====================================================\n"
                    << "  ToneCoach Debug Log\n"
                    << "  " << now.toString (true, true).toStdString() << "\n";

            if (sampleRate > 0.0)
                stream_ << "  Sample rate : " << sampleRate << " Hz\n"
                        << "  Window size : " << 2048 << " samples ("
                        << std::fixed << std::setprecision(1)
                        << (2048.0 / sampleRate * 1000.0) << " ms)\n";

            stream_ << "====================================================\n\n"
                    << std::left
                    << std::setw(8)  << "T(ms)"
                    << std::setw(10) << "RMS"
                    << std::setw(8)  << "dB"
                    << std::setw(10) << "RawHz"
                    << std::setw(10) << "SmoothHz"
                    << std::setw(8)  << "Conf"
                    << std::setw(6)  << "Str"
                    << std::setw(10) << "Target"
                    << std::setw(10) << "Cents"
                    << "Status\n"
                    << std::string (88, '-') << "\n";
            stream_.flush();

            logFilePath_ = logFile.getFullPathName().toStdString();
        }
    }

    // ── Log a structured tuner state row ───────────────────
    void logTunerState (float rms,
                        float rawHz,
                        float smoothHz,
                        float nsDFConf,       // 0..1 NSDF peak confidence
                        const char* stringName,
                        float targetHz,
                        float cents,
                        const char* status)
    {
        if (!stream_.is_open()) return;

        const auto now = std::chrono::steady_clock::now();
        const auto ms  = std::chrono::duration_cast<std::chrono::milliseconds>
                             (now - startTime_).count();
        const float dB = (rms > 1e-7f) ? 20.0f * std::log10f (rms) : -96.0f;

        std::lock_guard<std::mutex> lock (mutex_);
        stream_ << std::left  << std::fixed
                << std::setw(8)  << ms
                << std::setw(10) << std::setprecision(4) << rms
                << std::setw(8)  << std::setprecision(1) << dB
                << std::setw(10) << std::setprecision(1) << rawHz
                << std::setw(10) << std::setprecision(1) << smoothHz
                << std::setw(8)  << std::setprecision(3) << nsDFConf
                << std::setw(6)  << stringName
                << std::setw(10) << std::setprecision(2) << targetHz
                << std::setw(10) << std::setprecision(1) << cents
                << status << "\n";
    }

    // ── Log a free-text message with timestamp ─────────────
    void log (const juce::String& message)
    {
        if (!stream_.is_open()) return;

        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>
                            (std::chrono::steady_clock::now() - startTime_).count();
        std::lock_guard<std::mutex> lock (mutex_);
        stream_ << "[" << std::setw(7) << ms << "ms] "
                << message.toStdString() << "\n";
    }

    void flush()
    {
        std::lock_guard<std::mutex> lock (mutex_);
        if (stream_.is_open()) stream_.flush();
    }

    const std::string& getLogFilePath() const { return logFilePath_; }

    ~DebugLogger()
    {
        std::lock_guard<std::mutex> lock (mutex_);
        if (stream_.is_open())
        {
            stream_ << std::string (88, '=') << "\n"
                    << "  Session ended\n"
                    << std::string (88, '=') << "\n";
            stream_.close();
        }
    }

private:
    DebugLogger() = default;
    DebugLogger (const DebugLogger&) = delete;
    DebugLogger& operator= (const DebugLogger&) = delete;

    std::ofstream  stream_;
    std::mutex     mutex_;
    std::chrono::steady_clock::time_point startTime_;
    std::string    logFilePath_;
};

// ── Convenience macros ──────────────────────────────────────
#define TONECOACH_LOG_INIT(filename, sr)       DebugLogger::getInstance().init(filename, sr)
#define TONECOACH_LOG(msg)                     DebugLogger::getInstance().log(msg)
#define TONECOACH_LOG_FLUSH()                  DebugLogger::getInstance().flush()
#define TONECOACH_LOG_STATE(rms,raw,sm,conf,sn,tgt,cents,stat) \
    DebugLogger::getInstance().logTunerState(rms,raw,sm,conf,sn,tgt,cents,stat)

#else  // ── Release build: all macros → no-ops ────────────

#define TONECOACH_LOG_INIT(filename, sr)                        do {} while(0)
#define TONECOACH_LOG(msg)                                      do {} while(0)
#define TONECOACH_LOG_FLUSH()                                   do {} while(0)
#define TONECOACH_LOG_STATE(rms,raw,sm,conf,sn,tgt,cents,stat) do {} while(0)

#endif
