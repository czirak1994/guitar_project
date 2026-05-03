/**
 * detectNotes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure frontend DSP note detection using:
 *   • Energy-based onset detection     (RMS threshold + hysteresis)
 *   • Pitchy (McLeod Pitch Method)     for reliable pitch estimation
 *   • Median-3 pitch smoothing         to reject momentary glitches
 *   • 80 ms minimum-gap debounce       to prevent duplicate triggers
 *   • Same-pitch dedup (100 ms / ±1 st) to collapse double-pluck artefacts
 *   • Beat alignment + quantization    auto-aligned phase, signed ms offset
 *
 * Input:  Float32Array PCM samples + sampleRate + optional bpm
 * Output: { notes, duration, beats, phaseS }
 *
 * notes array element format (matches PlaybackTimeline expectations):
 *   { time_s, freq_hz, note, confidence, beat_offset_ms, beat_time_s, timing }
 *
 * Usage:
 *   import { detectNotes } from './utils/detectNotes'
 *   const { notes, duration } = detectNotes(pcmSamples, sampleRate, bpm)
 */

import { PitchDetector } from 'pitchy'

// ── Constants ─────────────────────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const A4_FREQ    = 440.0

/** Guitar frequency range — reject anything outside E2 (82 Hz) … e5 (1318 Hz) */
const GUITAR_MIN_HZ = 75
const GUITAR_MAX_HZ = 1400

const FRAME_SIZE       = 2048  // ~46 ms at 44.1 kHz — good resolution for guitar
const HOP_SIZE         = 512   // ~12 ms step
const RMS_THRESHOLD    = 0.01  // below this = silence
const CLARITY_THRESH   = 0.85  // pitchy confidence; guitar fundamental is reliable at 0.85+
const MIN_NOTE_GAP_MS  = 80    // minimum time between successive notes
const ONSET_RATIO      = 1.5   // RMS must be ONSET_RATIO × threshold when rising
const SAME_PITCH_SEMI  = 1     // ± semitones for same-pitch dedup
const SAME_PITCH_MS    = 100   // max gap for same-pitch dedup
// ── Helpers ───────────────────────────────────────────────────────────────────

function calcRms(buf) {
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}

function median3(a, b, c) {
  if (a <= b) {
    if (b <= c) return b   // a ≤ b ≤ c
    if (a <= c) return c   // a ≤ c < b
    return a               // c < a ≤ b
  }
  // b < a
  if (a <= c) return a     // b < a ≤ c
  if (b <= c) return c     // b ≤ c < a
  return b                 // c < b < a
}

/**
 * Convert frequency in Hz to a note name string like "A4" or "E2".
 */
function freqToNoteName(freq) {
  if (!freq || freq < 20) return '?'
  const semitones = 12 * Math.log2(freq / A4_FREQ)
  const midi      = Math.round(semitones) + 69
  const octave    = Math.floor(midi / 12) - 1
  const name      = NOTE_NAMES[((midi % 12) + 12) % 12]
  return `${name}${octave}`
}
function freqToMidi(freq) {
  if (!freq || freq < 20) return -1
  return Math.round(12 * Math.log2(freq / A4_FREQ)) + 69
}

/**
 * Remove notes that are the same pitch (±SAME_PITCH_SEMI semitones) as the
 * immediately preceding note AND within SAME_PITCH_MS — keeps only the first.
 * Assumes notes are already sorted by time_s.
 */
function mergeSimilarNotes(notes) {
  if (!notes.length) return notes
  const out = [notes[0]]
  for (let i = 1; i < notes.length; i++) {
    const prev = out[out.length - 1]
    const gapMs = (notes[i].time_s - prev.time_s) * 1000
    if (gapMs <= SAME_PITCH_MS) {
      const semiDiff = Math.abs(freqToMidi(notes[i].freq_hz) - freqToMidi(prev.freq_hz))
      if (semiDiff <= SAME_PITCH_SEMI) continue   // skip — same note, too soon
    }
    out.push(notes[i])
  }
  return out
}

/**
 * Auto-detect grid phase by minimising Σ|note − nearest_beat|.
 * Mirrors the same algorithm in PlaybackTimeline.jsx (findBeatPhase)
 * so that both use the same phase and produce consistent coloring.
 * Returns phase in SECONDS.
 */
function computeBeatPhase(noteTimes_s, beatSec) {
  if (!noteTimes_s.length || beatSec <= 0) return 0
  let bestPhase = 0, bestErr = Infinity
  for (let i = 0; i < 200; i++) {
    const candidate = (i / 200) * beatSec
    let err = 0
    for (const t of noteTimes_s) {
      const pos = ((t - candidate) % beatSec + beatSec) % beatSec
      err += Math.min(pos, beatSec - pos)
    }
    if (err < bestErr) { bestErr = err; bestPhase = candidate }
  }
  return bestPhase
}

/**
 * Signed beat offset in ms for a note at timeS seconds.
 * Negative = early (played before beat), positive = late (played after beat).
 */
function signedBeatOffsetMs(timeS, beatSec, phaseS) {
  if (beatSec <= 0) return 0
  const pos    = ((timeS - phaseS) % beatSec + beatSec) % beatSec
  const signed = pos > beatSec / 2 ? pos - beatSec : pos
  return Math.round(signed * 1000 * 10) / 10
}
// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect notes in a PCM buffer and align them to the metronome beat grid.
 *
 * @param {Float32Array} samples     Raw audio samples (mono, any sample rate)
 * @param {number}       sampleRate
 * @param {number}       [bpm=120]   BPM from the UI metronome
 * @returns {{ notes: Array, duration: number, beats: number[], phaseS: number }}
 */
/**
 * @param {object|null} [calibration]  Optional calibration data from CalibrationModal
 *   calibration.thresholdRms  — measured onset threshold (replaces RMS_THRESHOLD)
 *   calibration.avgOffsetMs   — user's systematic timing bias in ms; subtracted
 *                                from every beat_offset_ms so the coloring is
 *                                bias-corrected (not applied to time_s itself)
 */
export function detectNotes(samples, sampleRate, bpm = 120, calibration = null) {
  const rmsThreshold = calibration?.thresholdRms ?? RMS_THRESHOLD
  const timingBiasMs = calibration?.avgOffsetMs  ?? 0

  const beatSec = 60 / bpm
  const beatMs  = 60000 / bpm
  const detector   = PitchDetector.forFloat32Array(FRAME_SIZE)
  const frame      = new Float32Array(FRAME_SIZE)

  const notes      = []
  let prevRms      = 0
  let lastNoteMs   = -Infinity
  const pitchBuf   = []   // last ≤3 valid pitches for smoothing

  const totalHops  = Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE)

  for (let hop = 0; hop <= totalHops; hop++) {
    const start = hop * HOP_SIZE

    // Copy frame (pitchy needs a dense Float32Array, not a subarray view)
    const end = Math.min(start + FRAME_SIZE, samples.length)
    frame.set(samples.subarray(start, end))
    if (end < start + FRAME_SIZE) frame.fill(0, end - start)

    const rms   = calcRms(frame)
    const nowMs = (start / sampleRate) * 1000

    // ── Silence gate ────────────────────────────────────────────────────────
    if (rms < rmsThreshold) {
      prevRms = rms
      pitchBuf.length = 0   // clear history in silence gaps
      continue
    }

    // ── Pitch detection ─────────────────────────────────────────────────────
    const [pitch, clarity] = detector.findPitch(frame, sampleRate)

    if (pitch !== null && clarity >= CLARITY_THRESH &&
        pitch >= GUITAR_MIN_HZ && pitch <= GUITAR_MAX_HZ) {
      pitchBuf.push(pitch)
      if (pitchBuf.length > 3) pitchBuf.shift()
    }

    // ── Onset detection ─────────────────────────────────────────────────────
    // Rising edge: RMS crosses threshold upward AND exceeds hysteresis ratio
    const isRising  = rms >= rmsThreshold * ONSET_RATIO && prevRms < rmsThreshold * ONSET_RATIO
    const gapOk     = nowMs - lastNoteMs > MIN_NOTE_GAP_MS

    if (isRising && gapOk && pitchBuf.length > 0) {
      // Median-3 smoothing (uses whatever we've accumulated — 1, 2, or 3 values)
      let smoothed
      if (pitchBuf.length === 3)      smoothed = median3(pitchBuf[0], pitchBuf[1], pitchBuf[2])
      else if (pitchBuf.length === 2) smoothed = (pitchBuf[0] + pitchBuf[1]) / 2
      else                             smoothed = pitchBuf[0]

      if (smoothed >= GUITAR_MIN_HZ && smoothed <= GUITAR_MAX_HZ) {
        notes.push({
          time_s:         Math.round(nowMs) / 1000,
          freq_hz:        Math.round(smoothed * 10) / 10,
          note:           freqToNoteName(smoothed),
          confidence:     Math.round(clarity * 100) / 100,
          beat_offset_ms: null,   // overwritten in beat-alignment pass below
        })
        lastNoteMs     = nowMs
        pitchBuf.length = 0   // reset after triggering
      }
    }

    prevRms = rms
  }

  // ── Step 6: remove same-pitch duplicates ───────────────────────────────────
  const dedupedNotes = mergeSimilarNotes(notes)

  // ── Step 1–4: Beat grid + alignment ──────────────────────────────────────
  const duration = samples.length / sampleRate

  // Auto-align phase so beat grid matches the actual playing (same algorithm
  // as PlaybackTimeline.findBeatPhase — ensures consistent coloring there too)
  const phaseS = computeBeatPhase(dedupedNotes.map(n => n.time_s), beatSec)

  // Generate the full beat list for debug / UI use
  const beats = []  // in seconds
  for (let t = phaseS; t <= duration + beatSec; t += beatSec) {
    beats.push(Math.round(t * 1000) / 1000)
  }

  // Annotate each note with beat alignment data
  const alignedNotes = dedupedNotes.map(n => {
    // Apply calibrated timing-bias correction: if user consistently plays
    // +40 ms late, subtract 40 ms so beat_offset_ms reflects relative accuracy
    // rather than systematic hardware / reaction lag.  time_s is kept raw.
    const rawOffsetMs = signedBeatOffsetMs(n.time_s, beatSec, phaseS)
    const offsetMs    = Math.round((rawOffsetMs - timingBiasMs) * 10) / 10
    const absMs       = Math.abs(offsetMs)

    // Timing classification
    let timing
    if (absMs < 20)      timing = 'on'
    else if (absMs < 60) timing = 'close'
    else if (offsetMs < 0) timing = 'early'
    else                   timing = 'late'

    // Nearest beat time
    const pos       = ((n.time_s - phaseS) % beatSec + beatSec) % beatSec
    const nearestBeatOffset = pos > beatSec / 2 ? pos - beatSec : pos
    const beat_time_s = Math.round((n.time_s - nearestBeatOffset) * 1000) / 1000

    return { ...n, beat_offset_ms: offsetMs, beat_time_s, timing }
  })

  // ── Debug log ──────────────────────────────────────────────────────────
  console.log('[detectNotes]', {
    bpm,
    beatMs: Math.round(beatMs),
    phaseS: phaseS.toFixed(3),
    totalNotes: notes.length,
    afterDedup: dedupedNotes.length,
    rmsThreshold: rmsThreshold.toFixed(5),
    timingBiasMs,
    beats: beats.slice(0, 8).map(b => b.toFixed(2)),   // first 8 beats
    offsets: alignedNotes.map(n => ({ note: n.note, time_s: n.time_s, offset_ms: n.beat_offset_ms, timing: n.timing })),
  })

  return {
    notes:    alignedNotes,
    duration,
    beats,
    phaseS,
  }
}
