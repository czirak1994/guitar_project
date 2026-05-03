/**
 * calibrate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions for audio calibration analysis.
 *
 * Input calibration  — measures noise floor and signal level from a short
 *   recording to compute a per-device RMS onset threshold.
 *
 * Timing calibration — measures the user's systematic timing bias (average
 *   early/late offset) from a short metronome-guided recording so that
 *   beat_offset_ms can be corrected by that constant shift.
 *
 * localStorage keys:
 *   ts_input_cal   → { thresholdRms, noiseFloorDb, signalDb, ts }
 *   ts_timing_cal  → { avgOffsetMs, noteCount, ts }
 */

// ── Shared helpers ────────────────────────────────────────────────────────────

export function calcRms(buf) {
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}

export function rmsToDb(rms) {
  if (rms <= 0) return -Infinity
  return 20 * Math.log10(rms)
}

const NOISE_WINDOW_MS = 500   // first 500 ms treated as background

// ── Input calibration ─────────────────────────────────────────────────────────

/**
 * Analyze a PCM buffer captured for input calibration.
 *
 * Protocol: user stays silent for first 500 ms, then plays a single clean note.
 *
 * @param {Float32Array} samples
 * @param {number}       sampleRate
 * @returns {{ thresholdRms: number, noiseFloorDb: number, signalDb: number, thresholdDb: number }}
 */
export function analyzeInputCalibration(samples, sampleRate) {
  const noiseEndSample = Math.floor(sampleRate * NOISE_WINDOW_MS / 1000)

  const noiseSlice  = samples.subarray(0, noiseEndSample)
  const signalSlice = samples.subarray(noiseEndSample)

  const noiseRms  = calcRms(noiseSlice)
  const signalRms = calcRms(signalSlice)

  const noiseFloorDb = rmsToDb(noiseRms)
  const signalDb     = rmsToDb(signalRms)

  // threshold = noise_floor + 10 dB (in linear: × 10^0.5 ≈ 3.162)
  const thresholdRms = Math.max(noiseRms * 3.162, 0.004)  // hard floor at 0.004
  const thresholdDb  = rmsToDb(thresholdRms)

  console.log('[calibrate:input]', {
    noiseFloorDb: noiseFloorDb.toFixed(1),
    signalDb: signalDb.toFixed(1),
    thresholdDb: thresholdDb.toFixed(1),
    thresholdRms: thresholdRms.toFixed(5),
  })

  return { thresholdRms, noiseFloorDb, signalDb, thresholdDb }
}

// ── Timing calibration ────────────────────────────────────────────────────────

/**
 * Compute the beat-aligned phase using the same 200-candidate search as
 * detectNotes.js / PlaybackTimeline.jsx so all three are consistent.
 */
function computeBeatPhase(times_s, beatSec) {
  if (!times_s.length || beatSec <= 0) return 0
  let bestPhase = 0, bestErr = Infinity
  for (let i = 0; i < 200; i++) {
    const candidate = (i / 200) * beatSec
    let err = 0
    for (const t of times_s) {
      const pos = ((t - candidate) % beatSec + beatSec) % beatSec
      err += Math.min(pos, beatSec - pos)
    }
    if (err < bestErr) { bestErr = err; bestPhase = candidate }
  }
  return bestPhase
}

function signedBeatOffsetMs(timeS, beatSec, phaseS) {
  const pos    = ((timeS - phaseS) % beatSec + beatSec) % beatSec
  const signed = pos > beatSec / 2 ? pos - beatSec : pos
  return signed * 1000
}

/**
 * Analyze a timing-calibration PCM buffer.
 *
 * Protocol: user plays ~8 notes evenly spaced at the given BPM while a
 * metronome click track plays. We detect those notes, align them to the beat
 * grid, and compute the average signed offset (user's systematic bias).
 *
 * @param {number[]} noteTimes_s   Already-detected note timestamps (seconds)
 * @param {number}   bpm
 * @param {number}   duration      Recording duration in seconds
 * @returns {{ avgOffsetMs: number, noteCount: number, offsets: number[] }}
 */
export function analyzeTimingCalibration(noteTimes_s, bpm, duration) {
  if (!noteTimes_s.length) {
    return { avgOffsetMs: 0, noteCount: 0, offsets: [] }
  }

  const beatSec = 60 / bpm
  const phaseS  = computeBeatPhase(noteTimes_s, beatSec)

  const offsets = noteTimes_s.map(t => signedBeatOffsetMs(t, beatSec, phaseS))

  // Trim outliers: discard top/bottom 20% so a misfret doesn't bias the result
  const sorted  = [...offsets].sort((a, b) => a - b)
  const trimN   = Math.floor(sorted.length * 0.2)
  const trimmed = sorted.slice(trimN, sorted.length - trimN)

  const avgOffsetMs = trimmed.length
    ? Math.round(trimmed.reduce((s, v) => s + v, 0) / trimmed.length * 10) / 10
    : 0

  console.log('[calibrate:timing]', {
    bpm,
    noteCount: noteTimes_s.length,
    phaseS: phaseS.toFixed(3),
    offsets: offsets.map(o => Math.round(o)),
    avgOffsetMs,
  })

  return { avgOffsetMs, noteCount: noteTimes_s.length, offsets }
}

// ── localStorage persistence ──────────────────────────────────────────────────

const KEY_INPUT  = 'ts_input_cal'
const KEY_TIMING = 'ts_timing_cal'

export function saveInputCalibration(result) {
  try { localStorage.setItem(KEY_INPUT, JSON.stringify({ ...result, ts: Date.now() })) } catch {}
}

export function saveTimingCalibration(result) {
  try { localStorage.setItem(KEY_TIMING, JSON.stringify({ ...result, ts: Date.now() })) } catch {}
}

export function loadCalibration() {
  let input = null, timing = null
  try { input  = JSON.parse(localStorage.getItem(KEY_INPUT)  || 'null') } catch {}
  try { timing = JSON.parse(localStorage.getItem(KEY_TIMING) || 'null') } catch {}
  return { input, timing }
}

export function clearCalibration() {
  try { localStorage.removeItem(KEY_INPUT);  } catch {}
  try { localStorage.removeItem(KEY_TIMING); } catch {}
}
