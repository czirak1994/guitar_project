/**
 * detectNotes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic, LLM-free note detection pipeline:
 *   • Pass 1 — collect per-hop RMS + YIN pitch for every frame
 *   • Pass 2 — onset detection with re-arm gate (silence required between notes)
 *   • Pass 3 — pitch matching: median of stable frames 20–300 ms after onset
 *   • Same-pitch dedup (250 ms / ±1 semitone) to collapse any remaining artefacts
 *   • Beat alignment via 200-candidate phase brute-force
 *
 * Input:  Float32Array PCM samples + sampleRate + optional bpm + optional calibration
 * Output: { notes, duration, beats, phaseS }
 *
 * notes element: { time_s, freq_hz, note, confidence, beat_offset_ms, beat_time_s, timing }
 *
 * Usage:
 *   import { detectNotes } from './utils/detectNotes'
 *   const { notes, duration } = detectNotes(pcmSamples, sampleRate, bpm)
 */

import { YIN } from 'pitchfinder'

// ── Constants ─────────────────────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const A4_FREQ    = 440.0

/** Guitar frequency range — E2 (82 Hz) to e5 (1318 Hz) with margin */
const GUITAR_MIN_HZ = 75
const GUITAR_MAX_HZ = 1400

const FRAME_SIZE        = 2048  // ~46 ms at 44.1 kHz
const HOP_SIZE          = 512   // ~12 ms step
const RMS_THRESHOLD     = 0.01  // below this = silence
const ONSET_RATIO       = 2.0   // RMS must be 2× threshold to count as an onset
const MIN_NOTE_GAP_MS   = 150   // hard floor — prevents double-trigger if re-arm fails
const SAME_PITCH_SEMI   = 1     // ±1 semitone for same-pitch dedup
const SAME_PITCH_MS     = 250   // max gap for same-pitch dedup
const PITCH_WIN_MIN_MS  = 20    // earliest frame to sample pitch after onset
const PITCH_WIN_MAX_MS  = 300   // latest frame to sample pitch after onset

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcRms(buf) {
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}

function medianOf(arr) {
  if (!arr.length) return 0
  const sorted = arr.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

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
 * Remove notes that are the same pitch (±SAME_PITCH_SEMI) AND within
 * SAME_PITCH_MS of the previous note — keeps only the first occurrence.
 */
function mergeSimilarNotes(notes) {
  if (!notes.length) return notes
  const out = [notes[0]]
  for (let i = 1; i < notes.length; i++) {
    const prev  = out[out.length - 1]
    const gapMs = (notes[i].time_s - prev.time_s) * 1000
    if (gapMs <= SAME_PITCH_MS) {
      const semiDiff = Math.abs(freqToMidi(notes[i].freq_hz) - freqToMidi(prev.freq_hz))
      if (semiDiff <= SAME_PITCH_SEMI) continue
    }
    out.push(notes[i])
  }
  return out
}

/** Auto-align beat grid phase — mirrors PlaybackTimeline.findBeatPhase */
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
 * @param {number}       [bpm=120]
 * @param {object|null}  [calibration]
 *   calibration.thresholdRms  — measured onset threshold (replaces RMS_THRESHOLD)
 *   calibration.avgOffsetMs   — systematic timing bias in ms; subtracted from
 *                                beat_offset_ms (bias-correction, not raw time)
 * @returns {{ notes: Array, duration: number, beats: number[], phaseS: number }}
 */
export function detectNotes(samples, sampleRate, bpm = 120, calibration = null) {
  const rmsThreshold = calibration?.thresholdRms ?? RMS_THRESHOLD
  const timingBiasMs = calibration?.avgOffsetMs  ?? 0

  const beatSec = 60 / bpm
  const beatMs  = 60000 / bpm

  // Create YIN detector once — reused for every frame
  const yin = YIN({ sampleRate, threshold: 0.10 })
  const frame = new Float32Array(FRAME_SIZE)

  const totalHops = Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE)

  // ── Pass 1: collect per-hop RMS + pitch ──────────────────────────────────
  // We defer onset detection to pass 2 so pitch data from AFTER the onset
  // is available when we decide where the note boundary is.
  const hopData = []  // { ms, rms, pitch: number|null }

  for (let hop = 0; hop <= totalHops; hop++) {
    const start = hop * HOP_SIZE
    const end   = Math.min(start + FRAME_SIZE, samples.length)
    frame.set(samples.subarray(start, end))
    if (end < start + FRAME_SIZE) frame.fill(0, end - start)

    const rms   = calcRms(frame)
    const nowMs = (start / sampleRate) * 1000

    let pitch = null
    if (rms >= rmsThreshold) {
      const detected = yin(frame)
      if (detected !== null && detected >= GUITAR_MIN_HZ && detected <= GUITAR_MAX_HZ) {
        pitch = detected
      }
    }

    hopData.push({ ms: nowMs, rms, pitch })
  }

  // ── Pass 2: onset detection with re-arm gate ─────────────────────────────
  // After each onset the gate disarms. It only re-arms once RMS falls below
  // rmsThreshold (silence), preventing the double-trigger caused by the
  // attack transient dip + sustain rise pattern common on guitar.
  const onsets = []  // onset times in ms
  let armed       = true
  let prevRms     = 0
  let lastOnsetMs = -Infinity

  for (const { ms, rms } of hopData) {
    if (rms < rmsThreshold) {
      armed   = true   // re-arm: returning from silence
      prevRms = rms
      continue
    }

    // Rising edge crosses the onset hysteresis level while armed
    if (armed &&
        rms    >= rmsThreshold * ONSET_RATIO &&
        prevRms < rmsThreshold * ONSET_RATIO &&
        ms - lastOnsetMs > MIN_NOTE_GAP_MS) {
      onsets.push(ms)
      lastOnsetMs = ms
      armed = false  // disarm until next silence gap
    }

    prevRms = rms
  }

  // ── Pass 3: match pitch to each onset ────────────────────────────────────
  // For each onset, take the MEDIAN of YIN pitches in the stable-sustain
  // window (PITCH_WIN_MIN_MS … PITCH_WIN_MAX_MS after the onset).
  // This avoids the noisy attack transient and uses the cleaner sustain.
  const rawNotes = []

  for (const onsetMs of onsets) {
    const windowPitches = hopData
      .filter(h =>
        h.ms >= onsetMs + PITCH_WIN_MIN_MS &&
        h.ms <= onsetMs + PITCH_WIN_MAX_MS &&
        h.pitch !== null
      )
      .map(h => h.pitch)

    if (!windowPitches.length) continue   // no stable pitch found — skip onset

    const freq = medianOf(windowPitches)
    if (freq < GUITAR_MIN_HZ || freq > GUITAR_MAX_HZ) continue

    rawNotes.push({
      time_s:         Math.round(onsetMs) / 1000,
      freq_hz:        Math.round(freq * 10) / 10,
      note:           freqToNoteName(freq),
      confidence:     0.9,  // YIN does not expose per-frame confidence
      beat_offset_ms: null,
    })
  }

  // ── Same-pitch dedup ──────────────────────────────────────────────────────
  const dedupedNotes = mergeSimilarNotes(rawNotes)

  // ── Beat grid alignment ───────────────────────────────────────────────────
  const duration = samples.length / sampleRate
  const phaseS   = computeBeatPhase(dedupedNotes.map(n => n.time_s), beatSec)

  const beats = []
  for (let t = phaseS; t <= duration + beatSec; t += beatSec) {
    beats.push(Math.round(t * 1000) / 1000)
  }

  const alignedNotes = dedupedNotes.map(n => {
    const rawOffsetMs = signedBeatOffsetMs(n.time_s, beatSec, phaseS)
    const offsetMs    = Math.round((rawOffsetMs - timingBiasMs) * 10) / 10
    const absMs       = Math.abs(offsetMs)

    let timing
    if (absMs < 20)        timing = 'on'
    else if (absMs < 60)   timing = 'close'
    else if (offsetMs < 0) timing = 'early'
    else                   timing = 'late'

    const pos             = ((n.time_s - phaseS) % beatSec + beatSec) % beatSec
    const nearestBeatOff  = pos > beatSec / 2 ? pos - beatSec : pos
    const beat_time_s     = Math.round((n.time_s - nearestBeatOff) * 1000) / 1000

    return { ...n, beat_offset_ms: offsetMs, beat_time_s, timing }
  })

  // ── Debug log ──────────────────────────────────────────────────────────
  console.log('[detectNotes]', {
    bpm,
    beatMs: Math.round(beatMs),
    phaseS: phaseS.toFixed(3),
    onsetsDetected: onsets.length,
    afterPitchMatch: rawNotes.length,
    afterDedup: dedupedNotes.length,
    rmsThreshold: rmsThreshold.toFixed(5),
    timingBiasMs,
    beats: beats.slice(0, 8).map(b => b.toFixed(2)),
    offsets: alignedNotes.map(n => ({ note: n.note, time_s: n.time_s, offset_ms: n.beat_offset_ms, timing: n.timing })),
  })

  return {
    notes:    alignedNotes,
    duration,
    beats,
    phaseS,
  }
}
