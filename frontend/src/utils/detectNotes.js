/**
 * detectNotes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure frontend DSP note detection using:
 *   • Energy-based onset detection  (RMS threshold + hysteresis)
 *   • Pitchy (McLeod Pitch Method)  for reliable pitch estimation
 *   • Median-3 pitch smoothing      to reject momentary glitches
 *   • 80 ms minimum-gap debounce    to prevent duplicate triggers
 *
 * Input:  Float32Array PCM samples + sampleRate
 * Output: { notes, duration }
 *
 * notes array element format (matches PlaybackTimeline expectations):
 *   { time_s, freq_hz, note, confidence, beat_offset_ms }
 *
 * Usage:
 *   import { detectNotes } from './utils/detectNotes'
 *   const { notes, duration } = await detectNotes(pcmSamples, sampleRate)
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

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect notes in a PCM buffer.
 *
 * @param {Float32Array} samples   Raw audio samples (mono, any sample rate)
 * @param {number}       sampleRate
 * @returns {{ notes: Array, duration: number }}
 */
export function detectNotes(samples, sampleRate) {
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
    if (rms < RMS_THRESHOLD) {
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
    const isRising  = rms >= RMS_THRESHOLD * ONSET_RATIO && prevRms < RMS_THRESHOLD * ONSET_RATIO
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
          beat_offset_ms: null,   // filled in by backend or PlaybackTimeline
        })
        lastNoteMs     = nowMs
        pitchBuf.length = 0   // reset after triggering
      }
    }

    prevRms = rms
  }

  // ── Debug log (Step 10) ─────────────────────────────────────────────────────
  console.log('[detectNotes]', { detectedNotes: notes.length, notes })

  return {
    notes,
    duration: samples.length / sampleRate,
  }
}
