#pragma once

#include <JuceHeader.h>
#include <array>
#include <atomic>
#include "DebugLogger.h"
#include "WebSocketSender.h"
#include <cmath>
#include <string>

// ============================================================
//  PitchDetector  (McLeod / NSDF — unchanged)
// ============================================================
class PitchDetector
{
public:
    static constexpr int   kWindowSize   = 2048;
    static constexpr float kMinFrequency = 60.0f;
    static constexpr float kMaxFrequency = 1400.0f;
    static constexpr float kMinRMS       = 0.001f;

    /** outConf receives the NSDF global max (0..1) — used for debug logging.
     *  Pass nullptr in release to skip it. */
    static float detect (const float* samples, int numSamples, double sampleRate,
                         float* outConf = nullptr) noexcept;

private:
    static float parabolicInterpolation (const float* nsdf, int lag, int size) noexcept;
};

// ============================================================
//  GuitarString  —  standard tuning reference
// ============================================================
struct GuitarString
{
    const char* name;       // e.g. "E2"
    float       frequency;  // Hz
};

// ============================================================
//  MainComponent  —  guitar tuner
// ============================================================
class MainComponent : public juce::AudioAppComponent,
                      public juce::Timer
{
public:
    // ── Standard guitar tuning ──────────────────────────────
    static constexpr int kNumStrings = 6;
    static const GuitarString kStrings[kNumStrings];

    // ── Tuner helpers ───────────────────────────────────────
    /** Returns index of the closest guitar string to hz (log-scale distance). */
    static int   getClosestString (float hz) noexcept;

    /** Returns deviation in cents: positive = sharp, negative = flat.
     *  cents = 1200 * log2(detected / target) */
    static float calculateCents (float detectedHz, float targetHz) noexcept;

    MainComponent();
    ~MainComponent() override;

    // AudioAppComponent
    void prepareToPlay (int samplesPerBlockExpected, double sampleRate) override;
    void getNextAudioBlock (const juce::AudioSourceChannelInfo& bufferToFill) override;
    void releaseResources() override;

    // Timer (30 Hz UI refresh)
    void timerCallback() override;

    // Component
    void paint (juce::Graphics& g) override;
    void resized() override;

private:
    // ── Audio thread ────────────────────────────────────────
    double sampleRate_ { 44100.0 };
    std::array<float, PitchDetector::kWindowSize * 2> ringBuffer_ {};
    int   ringWritePos_     { 0 };
    int   samplesCollected_ { 0 };
    float smoothedFreq_     { 0.0f };
    static constexpr float kSmoothAlpha     = 0.15f;
    static constexpr float kStabilityHz     = 3.0f;
    static constexpr int   kFramesRequired  = 3;
    float lastPublishedFreq_ { 0.0f };
    int   stableFrames_      { 0 };

    // ── Lock-free cross-thread values ───────────────────────
    std::atomic<float> atomicHz_      { 0.0f };
    std::atomic<float> atomicRMS_     { 0.0f };
    std::atomic<float> atomicRawHz_   { 0.0f };  // raw (pre-EMA) pitch
    std::atomic<float> atomicNSDFConf_{ 0.0f };  // NSDF peak confidence (0..1)

    // ── UI-thread state ──────────────────────────────────────
    float       needleCents_     { 0.0f };
    int         logFrameCount_   { 0 };
    int         jsonWriteCounter_ { 0 };  // WebSocket send every ~3 timer ticks (~100ms)

    // Last stable tuner values (message thread only)
    juce::String currentNote_    { "--" };
    float        currentHz_      { 0.0f };
    float        currentCents_   { 0.0f };
    juce::String currentStatus_  { "NoSignal" };

    // ── Widgets ───────────────────────────────────────
    juce::Label      stringLabel_;            // "E2"
    juce::Label      freqLabel_;              // "82.4 Hz"
    juce::Label      centsLabel_;             // "-12.0 cents"
    juce::Label      statusLabel_;            // "Too Low" / "In Tune!" / "Too High"
    juce::Label      levelLabel_;             // input level
    juce::Label      wsStatusLabel_;          // WebSocket connection indicator
    juce::TextButton deviceButton_ { "Audio Device..." };

    // ── WebSocket sender ──────────────────────────────────
    WebSocketSender  wsSender_;

    // ── Drawing helpers ─────────────────────────────────────
    /** Draws the arc gauge with coloured zones and needle. */
    void drawTunerArc (juce::Graphics& g,
                       juce::Rectangle<float> bounds,
                       float cents,
                       bool  active) const;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)
};
