#include "MainComponent.h"
#include "DebugLogger.h"
#include <cstring>
#include <iomanip>
#include <sstream>

// ============================================================
//  Standard guitar tuning table  (E A D G B e)
// ============================================================
const GuitarString MainComponent::kStrings[MainComponent::kNumStrings] = {
    { "E2",  82.41f  },
    { "A2",  110.00f },
    { "D3",  146.83f },
    { "G3",  196.00f },
    { "B3",  246.94f },
    { "E4",  329.63f }
};

// ============================================================
//  PitchDetector::detect   (McLeod / NSDF)
// ============================================================
float PitchDetector::detect (const float* samples,
                              int          numSamples,
                              double       sampleRate,
                              float*       outConf) noexcept
{
    // 1. RMS silence gate
    float sumSq = 0.0f;
    for (int i = 0; i < numSamples; ++i)
        sumSq += samples[i] * samples[i];
    if (std::sqrt (sumSq / static_cast<float> (numSamples)) < kMinRMS)
        return 0.0f;

    // 2. Lag bounds  (guitar: E2=82 Hz … E4=330 Hz + harmonics)
    const int maxLag = juce::jmin (static_cast<int> (sampleRate / kMinFrequency), numSamples / 2 - 1);
    const int minLag = static_cast<int> (sampleRate / kMaxFrequency);
    if (minLag >= maxLag)
        return 0.0f;

    // 3. NSDF  nsdf(lag) = 2*ACF(lag) / m'(lag)
    //    result in [-1,1]; peaks near +1 = strong periodicity
    static thread_local float nsdf[PitchDetector::kWindowSize * 2] {};
    for (int lag = minLag; lag <= maxLag; ++lag)
    {
        double acf = 0.0, norm = 0.0;
        const int count = numSamples - lag;
        for (int i = 0; i < count; ++i)
        {
            const double xi  = samples[i];
            const double xiL = samples[i + lag];
            acf  += xi * xiL;
            norm += xi * xi + xiL * xiL;
        }
        nsdf[lag] = (norm > 1e-10) ? static_cast<float> (2.0 * acf / norm) : 0.0f;
    }

    // 4. McLeod peak picking
    //    a) Find global NSDF maximum
    float globalMax = 0.0f;
    for (int lag = minLag; lag <= maxLag; ++lag)
        globalMax = std::max (globalMax, nsdf[lag]);

    if (globalMax < 0.2f)   // signal too aperiodic → silence
    {
        if (outConf) *outConf = globalMax;
        return 0.0f;
    }

    if (outConf) *outConf = globalMax;

    //    b) Relative threshold = 85 % of globalMax
    const float relThreshold = globalMax * 0.85f;

    //    c) Scan positive lobes; take FIRST peak >= relThreshold
    //       (first lobe = shortest period = fundamental, not overtone)
    int   bestLag     = 0;
    float lobePeak    = 0.0f;
    int   lobePeakLag = 0;
    bool  inPositive  = (nsdf[minLag] > 0.0f);

    for (int lag = minLag + 1; lag <= maxLag; ++lag)
    {
        if (!inPositive && nsdf[lag] > 0.0f)
        {
            inPositive  = true;
            lobePeak    = 0.0f;
            lobePeakLag = 0;
        }

        if (inPositive)
        {
            if (nsdf[lag] > lobePeak)
            {
                lobePeak    = nsdf[lag];
                lobePeakLag = lag;
            }

            if (nsdf[lag] < 0.0f || lag == maxLag)
            {
                inPositive = false;
                if (lobePeakLag > 0 && lobePeak >= relThreshold)
                {
                    bestLag = lobePeakLag;
                    break;
                }
            }
        }
    }

    if (bestLag == 0)
        return 0.0f;

    // 5. Parabolic interpolation for sub-sample accuracy
    const float refined = parabolicInterpolation (nsdf, bestLag, maxLag);
    return (refined > 0.0f) ? static_cast<float> (sampleRate) / refined : 0.0f;
}

float PitchDetector::parabolicInterpolation (const float* nsdf, int lag, int size) noexcept
{
    if (lag <= 0 || lag >= size - 1) return static_cast<float> (lag);
    const float y0 = nsdf[lag - 1], y1 = nsdf[lag], y2 = nsdf[lag + 1];
    const float d  = 2.0f * (2.0f * y1 - y0 - y2);
    return (std::abs (d) < 1e-9f) ? static_cast<float> (lag)
                                  : static_cast<float> (lag) + (y0 - y2) / d;
}

// ============================================================
//  Tuner helpers
// ============================================================

/** Find the closest string by log2 distance (cents-space). */
int MainComponent::getClosestString (float hz) noexcept
{
    if (hz <= 0.0f) return 0;
    int   bestIdx  = 0;
    float bestDist = std::abs (std::log2f (hz / kStrings[0].frequency));
    for (int i = 1; i < kNumStrings; ++i)
    {
        const float dist = std::abs (std::log2f (hz / kStrings[i].frequency));
        if (dist < bestDist)
        {
            bestDist = dist;
            bestIdx  = i;
        }
    }
    return bestIdx;
}

/** cents = 1200 * log2(detected / target)
 *  positive = sharp, negative = flat */
float MainComponent::calculateCents (float detectedHz, float targetHz) noexcept
{
    if (detectedHz <= 0.0f || targetHz <= 0.0f) return 0.0f;
    return 1200.0f * std::log2f (detectedHz / targetHz);
}

// ============================================================
//  Constructor / Destructor
// ============================================================
MainComponent::MainComponent()
{
    setSize (520, 420);

    // ── String name (large, top-centre) ─────────────────────
    stringLabel_.setText ("--", juce::dontSendNotification);
    stringLabel_.setFont (juce::Font (juce::FontOptions{}.withHeight (56.0f).withStyle ("Bold")));
    stringLabel_.setJustificationType (juce::Justification::centred);
    stringLabel_.setColour (juce::Label::textColourId, juce::Colours::white);
    addAndMakeVisible (stringLabel_);

    // ── Raw frequency (small, below string name) ─────────────
    freqLabel_.setText ("-- Hz", juce::dontSendNotification);
    freqLabel_.setFont (juce::Font (juce::FontOptions{}.withHeight (18.0f)));
    freqLabel_.setJustificationType (juce::Justification::centred);
    freqLabel_.setColour (juce::Label::textColourId, juce::Colours::grey);
    addAndMakeVisible (freqLabel_);

    // ── Cents deviation (below gauge) ────────────────────────
    centsLabel_.setText ("", juce::dontSendNotification);
    centsLabel_.setFont (juce::Font (juce::FontOptions{}.withHeight (24.0f).withStyle ("Bold")));
    centsLabel_.setJustificationType (juce::Justification::centred);
    centsLabel_.setColour (juce::Label::textColourId, juce::Colours::white);
    addAndMakeVisible (centsLabel_);

    // ── Status text ──────────────────────────────────────────
    statusLabel_.setText ("Play a string...", juce::dontSendNotification);
    statusLabel_.setFont (juce::Font (juce::FontOptions{}.withHeight (16.0f)));
    statusLabel_.setJustificationType (juce::Justification::centred);
    statusLabel_.setColour (juce::Label::textColourId, juce::Colours::grey);
    addAndMakeVisible (statusLabel_);

    // ── Input level ──────────────────────────────────────────
    levelLabel_.setFont (juce::Font (juce::FontOptions{}.withHeight (13.0f)));
    levelLabel_.setJustificationType (juce::Justification::centred);
    levelLabel_.setColour (juce::Label::textColourId, juce::Colours::grey);
    addAndMakeVisible (levelLabel_);

    // ── Device button ────────────────────────────────────────
    deviceButton_.setColour (juce::TextButton::buttonColourId,  juce::Colour (0xff263238));
    deviceButton_.setColour (juce::TextButton::textColourOffId, juce::Colours::lightgrey);
    deviceButton_.onClick = [this]
    {
        juce::AudioDeviceManager& dm = deviceManager;
        auto* sel = new juce::AudioDeviceSelectorComponent (
            dm, 1, 1, 0, 0, false, false, false, false);
        sel->setSize (440, 340);
        juce::DialogWindow::LaunchOptions opts;
        opts.content.setOwned (sel);
        opts.dialogTitle                  = "Audio Device Settings";
        opts.dialogBackgroundColour       = juce::Colour (0xff1a1a2e);
        opts.escapeKeyTriggersCloseButton = true;
        opts.useNativeTitleBar            = true;
        opts.launchAsync();
    };
    addAndMakeVisible (deviceButton_);

    // ── WebSocket status indicator ────────────────────────────
    wsStatusLabel_.setFont (juce::Font (juce::FontOptions{}.withHeight (12.0f)));
    wsStatusLabel_.setJustificationType (juce::Justification::centred);
    wsStatusLabel_.setText ("WS: connecting...", juce::dontSendNotification);
    wsStatusLabel_.setColour (juce::Label::textColourId, juce::Colours::grey);
    addAndMakeVisible (wsStatusLabel_);

    setAudioChannels (1, 0);
    startTimerHz (30);

    // Start WebSocket sender thread (connects to ws://127.0.0.1:8765)
    wsSender_.startSending ("127.0.0.1", 8765);
}

MainComponent::~MainComponent()
{
    stopTimer();
    shutdownAudio();
}

// ============================================================
//  prepareToPlay
// ============================================================
void MainComponent::prepareToPlay (int samplesPerBlockExpected, double sampleRate)
{
    sampleRate_         = sampleRate;
    ringBuffer_.fill (0.0f);
    ringWritePos_       = 0;
    samplesCollected_   = 0;
    smoothedFreq_       = 0.0f;
    lastPublishedFreq_  = 0.0f;
    stableFrames_       = 0;
    atomicHz_           = 0.0f;
    atomicRMS_          = 0.0f;
    atomicRawHz_        = 0.0f;
    atomicNSDFConf_     = 0.0f;

    // Initialise the debug log file  (debug builds only)
    TONECOACH_LOG_INIT ("debug.log", sampleRate);
    TONECOACH_LOG (juce::String ("prepareToPlay | SR=") + juce::String (sampleRate, 0)
                   + " | bufSize=" + juce::String (samplesPerBlockExpected)
                   + " | windowSize=" + juce::String (PitchDetector::kWindowSize));
}

// ============================================================
//  releaseResources
// ============================================================
void MainComponent::releaseResources() {}

// ============================================================
//  getNextAudioBlock  —  real-time audio thread
//  Rule: NO heap allocation, NO blocking, NO UI calls.
// ============================================================
void MainComponent::getNextAudioBlock (const juce::AudioSourceChannelInfo& bufferToFill)
{
    const auto* buf = bufferToFill.buffer;
    if (buf->getNumChannels() == 0) return;

    const float* in         = buf->getReadPointer (0, bufferToFill.startSample);
    const int    numSamples = bufferToFill.numSamples;

    // Compute block RMS for level display
    float sumSq = 0.0f;
    for (int i = 0; i < numSamples; ++i)
        sumSq += in[i] * in[i];
    atomicRMS_.store (std::sqrt (sumSq / static_cast<float> (numSamples)),
                      std::memory_order_relaxed);

    // Accumulate into ring buffer
    for (int i = 0; i < numSamples; ++i)
    {
        ringBuffer_[ringWritePos_] = in[i];
        ringWritePos_ = (ringWritePos_ + 1) % PitchDetector::kWindowSize;
        ++samplesCollected_;
    }

    if (samplesCollected_ < PitchDetector::kWindowSize)
        return;

    samplesCollected_ = 0;

    // Build contiguous window  (no allocation — fixed-size thread_local array)
    static thread_local float win[PitchDetector::kWindowSize] {};
    for (int i = 0; i < PitchDetector::kWindowSize; ++i)
        win[i] = ringBuffer_[(ringWritePos_ + i) % PitchDetector::kWindowSize];

    // Detect pitch  (outConf → atomicNSDFConf_ for debug display)
    float nsdfConf = 0.0f;
    const float raw = PitchDetector::detect (win, PitchDetector::kWindowSize, sampleRate_, &nsdfConf);
    atomicRawHz_   .store (raw,      std::memory_order_relaxed);
    atomicNSDFConf_.store (nsdfConf, std::memory_order_relaxed);

    // EMA smoothing
    if (raw > 0.0f)
        smoothedFreq_ = (smoothedFreq_ <= 0.0f)
            ? raw
            : kSmoothAlpha * raw + (1.0f - kSmoothAlpha) * smoothedFreq_;
    else
    {
        smoothedFreq_ *= 0.85f;
        if (smoothedFreq_ < 1.0f) smoothedFreq_ = 0.0f;
    }

    // Stability gate — only publish after N frames within ±kStabilityHz
    if (smoothedFreq_ > 0.0f)
    {
        if (std::abs (smoothedFreq_ - lastPublishedFreq_) < kStabilityHz)
            ++stableFrames_;
        else
        {
            stableFrames_      = 0;
            lastPublishedFreq_ = smoothedFreq_;
        }

        if (stableFrames_ >= kFramesRequired)
        {
            stableFrames_ = 0;
            lastPublishedFreq_ = smoothedFreq_;
            atomicHz_.store (smoothedFreq_, std::memory_order_relaxed);
        }
    }
    else
    {
        atomicHz_.store (0.0f, std::memory_order_relaxed);
    }
}

// ============================================================
//  timerCallback  —  30 Hz UI refresh on the message thread
// ============================================================
void MainComponent::timerCallback()
{
    const float hz       = atomicHz_      .load (std::memory_order_relaxed);
    const float rms      = atomicRMS_     .load (std::memory_order_relaxed);
    const float rawHz    = atomicRawHz_   .load (std::memory_order_relaxed);
    const float nsDFConf = atomicNSDFConf_.load (std::memory_order_relaxed);
    const float smoothHz = smoothedFreq_; // read from audio thread — safe single-float

    // ── Level display ────────────────────────────────────────
    {
        const float dB = (rms > 1e-7f) ? 20.0f * std::log10f (rms) : -96.0f;
        std::ostringstream ss;
        ss << "Level: " << std::fixed << std::setprecision (4) << rms
           << "  (" << std::setprecision (1) << dB << " dB)";
        levelLabel_.setText (ss.str(), juce::dontSendNotification);
        levelLabel_.setColour (juce::Label::textColourId,
            rms > PitchDetector::kMinRMS ? juce::Colours::lightgreen
                                         : juce::Colours::orangered);
    }

    if (hz > 0.0f)
    {
        // ── Identify closest string ──────────────────────────
        const int   strIdx = getClosestString (hz);
        const float target = kStrings[strIdx].frequency;
        const float cents  = calculateCents (hz, target);

        // Smooth needle for animation (fast response, no jitter)
        needleCents_ = needleCents_ * 0.65f + cents * 0.35f;

        // ── String name ──────────────────────────────────────
        stringLabel_.setText (kStrings[strIdx].name, juce::dontSendNotification);

        // ── Frequency ────────────────────────────────────────
        std::ostringstream fss;
        fss << std::fixed << std::setprecision (1) << hz << " Hz";
        freqLabel_.setText (fss.str(), juce::dontSendNotification);

        // ── Cents label ──────────────────────────────────────
        std::ostringstream css;
        css << (cents >= 0.0f ? "+" : "")
            << std::fixed << std::setprecision (1) << cents << " cents";
        centsLabel_.setText (css.str(), juce::dontSendNotification);

        // ── Status + colour ──────────────────────────────────
        juce::String     status;
        juce::Colour     statusCol;
        if (cents < -5.0f)
        {
            status    = "Too Low";
            statusCol = juce::Colour (0xffff6b35);  // orange-red
        }
        else if (cents > 5.0f)
        {
            status    = "Too High";
            statusCol = juce::Colour (0xffff6b35);
        }
        else
        {
            status    = "In Tune!";
            statusCol = juce::Colour (0xff69f0ae);  // bright green
        }
        statusLabel_.setText  (status,    juce::dontSendNotification);
        statusLabel_.setColour (juce::Label::textColourId, statusCol);

        // Store stable state for JSON export (message thread only)
        currentNote_   = kStrings[strIdx].name;
        currentHz_     = hz;
        currentCents_  = cents;
        currentStatus_ = status;

        // ── Debug log  (throttled: every 10 frames ≈ 3x per second) ────
        if (++logFrameCount_ >= 10)
        {
            logFrameCount_ = 0;
            TONECOACH_LOG_STATE (rms, rawHz, smoothHz, nsDFConf,
                                 kStrings[strIdx].name, target,
                                 cents, status.toRawUTF8());
            TONECOACH_LOG_FLUSH();
        }
    }
    else
    {
        // Decay needle to centre when silent
        needleCents_ *= 0.85f;

        stringLabel_.setText ("--",                juce::dontSendNotification);
        freqLabel_  .setText ("-- Hz",             juce::dontSendNotification);
        centsLabel_ .setText ("",                  juce::dontSendNotification);
        statusLabel_.setText ("Play a string...", juce::dontSendNotification);
        statusLabel_.setColour (juce::Label::textColourId, juce::Colours::grey);

        currentNote_   = "--";
        currentHz_     = 0.0f;
        currentCents_  = 0.0f;
        currentStatus_ = "NoSignal";

        // Log silence state at the same rate
        if (++logFrameCount_ >= 10)
        {
            logFrameCount_ = 0;
            TONECOACH_LOG_STATE (rms, rawHz, smoothHz, nsDFConf,
                                 "--", 0.0f, 0.0f, "NoSignal");
        }
    }

    // ── WebSocket: update status indicator ─────────────────────
    if (wsSender_.isConnected())
    {
        wsStatusLabel_.setText ("WS: connected ●", juce::dontSendNotification);
        wsStatusLabel_.setColour (juce::Label::textColourId, juce::Colour (0xff69f0ae));
    }
    else
    {
        wsStatusLabel_.setText ("WS: disconnected (start ws_server.py)", juce::dontSendNotification);
        wsStatusLabel_.setColour (juce::Label::textColourId, juce::Colours::grey);
    }

    // ── WebSocket send every ~3 timer ticks (≈10 Hz) ─────────────
    if (++jsonWriteCounter_ >= 3)
    {
        jsonWriteCounter_ = 0;
        wsSender_.updateData (currentNote_, currentHz_,
                              currentCents_, currentStatus_);
    }

    repaint();  // trigger arc redraw
}

// ============================================================
//  paint
// ============================================================
void MainComponent::paint (juce::Graphics& g)
{
    // Background gradient
    g.setGradientFill (juce::ColourGradient (
        juce::Colour (0xff0d1117), 0, 0,
        juce::Colour (0xff161b22), 0, (float) getHeight(), false));
    g.fillAll();

    // Draw the tuner arc in the middle zone
    const bool active = (atomicHz_.load (std::memory_order_relaxed) > 0.0f);
    const auto arcBounds = juce::Rectangle<float> (
        20.0f, 95.0f,
        (float) getWidth() - 40.0f, 200.0f);
    drawTunerArc (g, arcBounds, needleCents_, active);
}

// ============================================================
//  drawTunerArc
//
//  Draws a half-circle gauge:
//    - Coloured arc zones (red / yellow / green)
//    - Tick marks at ±10, ±20, ±30, ±40, ±50 cents
//    - A needle pointing to the current deviation
//    - A pivot dot at the needle base
//
//  Coordinate convention used here:
//    angle = 0    → needle straight up    (0 cents, in tune)
//    angle = -π/2 → needle pointing left  (-50 cents, flat)
//    angle = +π/2 → needle pointing right (+50 cents, sharp)
//
//  In JUCE screen coords (y downward):
//    nx = cx + r * sin(angle)
//    ny = cy - r * cos(angle)   ← minus flips y-axis
// ============================================================
void MainComponent::drawTunerArc (juce::Graphics&        g,
                                   juce::Rectangle<float> bounds,
                                   float                  cents,
                                   bool                   active) const
{
    const float cx     = bounds.getCentreX();
    const float cy     = bounds.getBottom();        // pivot at bottom of area
    const float radius = bounds.getHeight() * 0.88f;

    // Maximum angular sweep: ±50 cents = ±75° from vertical
    const float kMaxAngle  = juce::MathConstants<float>::pi * 75.0f / 180.0f;
    const float kArcSteps  = 200;

    // ── 1. Coloured arc zones ────────────────────────────────
    // Draw many small line segments to create a colour-gradient arc.
    // Zones (by absolute cents from centre):
    //   0-5   → green  (in tune)
    //   5-20  → yellow
    //   20-50 → red

    auto centToAngle = [&] (float c) -> float
    {
        return juce::jlimit (-kMaxAngle, kMaxAngle,
                             c / 50.0f * kMaxAngle);
    };

    auto angleToXY = [&] (float a, float r) -> juce::Point<float>
    {
        return { cx + r * std::sin (a),
                 cy - r * std::cos (a) };
    };

    auto arcColour = [&] (float c) -> juce::Colour
    {
        const float ac = std::abs (c);
        if (ac <= 5.0f)  return juce::Colour (0xff69f0ae);  // green
        if (ac <= 20.0f) return juce::Colour (0xffffeb3b);  // yellow
        return                   juce::Colour (0xffff5252);  // red
    };

    // Draw arc as thick coloured strokes
    const float arcInner = radius * 0.82f;
    const float arcOuter = radius * 0.98f;

    for (int step = 0; step < (int) kArcSteps; ++step)
    {
        const float t0 = -50.0f + 100.0f * (float) step       / kArcSteps;
        const float t1 = -50.0f + 100.0f * (float) (step + 1) / kArcSteps;
        const float a0 = centToAngle (t0);
        const float a1 = centToAngle (t1);
        const float am = (a0 + a1) * 0.5f;

        g.setColour (arcColour (t0).withAlpha (active ? 0.85f : 0.25f));
        const auto p0 = angleToXY (a0, arcInner);
        const auto p1 = angleToXY (a1, arcInner);
        const auto p2 = angleToXY (a1, arcOuter);
        const auto p3 = angleToXY (a0, arcOuter);

        juce::Path seg;
        seg.startNewSubPath (p0);
        seg.lineTo (p1);
        seg.lineTo (p2);
        seg.lineTo (p3);
        seg.closeSubPath();
        g.fillPath (seg);
        (void) am;
    }

    // ── 2. Tick marks ────────────────────────────────────────
    // Minor ticks every 10 cents, label at ±50, ±25, 0
    const float tickInner = radius * 0.78f;
    const float tickOuter = radius * 1.00f;

    for (int c = -50; c <= 50; c += 10)
    {
        const float a   = centToAngle ((float) c);
        const auto  p0  = angleToXY (a, tickInner);
        const auto  p1  = angleToXY (a, tickOuter);
        g.setColour (juce::Colours::white.withAlpha (active ? 0.5f : 0.15f));
        g.drawLine (p0.x, p0.y, p1.x, p1.y, (c == 0) ? 2.5f : 1.0f);
    }

    // Centre tick (0 cents) — white, thicker
    {
        const auto p0 = angleToXY (0.0f, radius * 0.72f);
        const auto p1 = angleToXY (0.0f, radius * 1.02f);
        g.setColour (juce::Colours::white.withAlpha (active ? 0.9f : 0.3f));
        g.drawLine (p0.x, p0.y, p1.x, p1.y, 2.5f);
    }

    // ── 3. Needle ────────────────────────────────────────────
    const float clampedCents = juce::jlimit (-50.0f, 50.0f, cents);
    const float needleAngle  = centToAngle (clampedCents);
    const float needleLen    = radius * 0.80f;

    const auto needleTip  = angleToXY (needleAngle, needleLen);
    const auto needleBase = angleToXY (needleAngle + juce::MathConstants<float>::pi, 18.0f);

    // Shadow
    g.setColour (juce::Colours::black.withAlpha (0.4f));
    g.drawLine (needleBase.x + 1.5f, needleBase.y + 1.5f,
                needleTip.x  + 1.5f, needleTip.y  + 1.5f, 3.0f);

    // Needle
    const juce::Colour needleCol = active
        ? juce::Colours::white
        : juce::Colours::white.withAlpha (0.3f);
    g.setColour (needleCol);
    g.drawLine (needleBase.x, needleBase.y,
                needleTip.x,  needleTip.y,  2.5f);

    // Pivot dot
    g.setColour (juce::Colour (0xff00bcd4).withAlpha (active ? 1.0f : 0.3f));
    g.fillEllipse (cx - 7.0f, cy - 7.0f, 14.0f, 14.0f);
    g.setColour (juce::Colours::white.withAlpha (0.6f));
    g.drawEllipse (cx - 7.0f, cy - 7.0f, 14.0f, 14.0f, 1.5f);
}

// ============================================================
//  resized
// ============================================================
//  resized
// ============================================================
void MainComponent::resized()
{
    const int w = getWidth();
    const int h = getHeight();

    stringLabel_ .setBounds (0,       8,        w,   70);
    freqLabel_   .setBounds (0,       74,       w,   22);
    // Arc is drawn in paint() between y=95 and y=295
    centsLabel_  .setBounds (0,       300,      w,   34);
    statusLabel_ .setBounds (0,       336,      w,   24);
    levelLabel_  .setBounds (0,       358,      w,   18);
    wsStatusLabel_.setBounds(0,       378,      w,   16);
    deviceButton_.setBounds (w/2-90,  h - 34,  180,  30);
}


