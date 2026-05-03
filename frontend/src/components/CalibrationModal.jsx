/**
 * CalibrationModal.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Two-step calibration wizard (< 10 seconds total):
 *
 *  Step 1 — Input calibration
 *    "Stay quiet for 2 s, then play a single clean note"
 *    Measures noise floor → computes RMS onset threshold.
 *
 *  Step 2 — Timing calibration
 *    "Play 8 notes with the metronome"
 *    Detects note timestamps → computes avg early/late bias.
 *
 * Props:
 *   isOpen    boolean
 *   bpm       number  (from UI metronome)
 *   deviceId  string|null
 *   onComplete({ inputCal, timingCal })  — called when both steps finish
 *   onClose()  — called when user dismisses
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import { analyzeInputCalibration, analyzeTimingCalibration } from '../utils/calibrate'
import { detectNotes } from '../utils/detectNotes'

// ── Tiny inline click track (Web Audio oscillator) ───────────────────────────
function useClickTrack(bpm, enabled) {
  const ctxRef  = useRef(null)
  const timerRef = useRef(null)
  const nextRef  = useRef(0)
  const beatRef  = useRef(0)

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      ctxRef.current.close().catch(() => {})
    }
    ctxRef.current = null
  }, [])

  const start = useCallback(() => {
    stop()
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    ctxRef.current = ctx
    if (ctx.state === 'suspended') ctx.resume()
    nextRef.current = ctx.currentTime + 0.05
    beatRef.current = 0

    const interval  = 60 / bpm
    const LOOKAHEAD = 0.1
    function tick() {
      while (nextRef.current < ctx.currentTime + LOOKAHEAD) {
        const t      = nextRef.current
        const accent = beatRef.current === 0
        const freq   = accent ? 1760 : 880
        const gain   = accent ? 0.45 : 0.28
        const dur    = 0.04
        const osc    = ctx.createOscillator()
        const env    = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, t)
        env.gain.setValueAtTime(gain, t)
        env.gain.exponentialRampToValueAtTime(0.001, t + dur)
        osc.connect(env)
        env.connect(ctx.destination)
        osc.start(t)
        osc.stop(t + dur)
        beatRef.current    = (beatRef.current + 1) % 4
        nextRef.current   += interval
      }
    }
    tick()
    timerRef.current = setInterval(tick, 25)
  }, [bpm, stop])

  useEffect(() => {
    if (enabled) start()
    else stop()
    return stop
  }, [enabled, start, stop])

  return stop
}

// ── Recording helper ──────────────────────────────────────────────────────────
function useCalRecorder(deviceId) {
  const streamRef    = useRef(null)
  const processorRef = useRef(null)
  const sourceRef    = useRef(null)
  const ctxRef       = useRef(null)
  const chunksRef    = useRef([])
  const srRef        = useRef(44100)

  const start = useCallback(async () => {
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      }
    }
    const stream   = await navigator.mediaDevices.getUserMedia(constraints)
    const ctx      = new (window.AudioContext || window.webkitAudioContext)()
    const source   = ctx.createMediaStreamSource(stream)
    const proc     = ctx.createScriptProcessor(4096, 1, 1)
    chunksRef.current = []
    srRef.current     = ctx.sampleRate

    proc.onaudioprocess = (e) => {
      chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }
    source.connect(proc)
    proc.connect(ctx.destination)

    streamRef.current    = stream
    processorRef.current = proc
    sourceRef.current    = source
    ctxRef.current       = ctx
    return ctx.sampleRate
  }, [deviceId])

  const stop = useCallback(() => {
    if (processorRef.current) { try { processorRef.current.disconnect() } catch {} }
    if (sourceRef.current)    { try { sourceRef.current.disconnect()    } catch {} }
    if (streamRef.current)    streamRef.current.getTracks().forEach(t => t.stop())
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      ctxRef.current.close().catch(() => {})
    }

    const chunks = chunksRef.current
    const total  = chunks.reduce((a, c) => a + c.length, 0)
    const out    = new Float32Array(total)
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.length }
    return { samples: out, sampleRate: srRef.current }
  }, [])

  return { start, stop }
}

// ── Main component ────────────────────────────────────────────────────────────

const STEP_LABELS = ['Setup', 'Mic level', 'Timing', 'Done']

/**
 * Phases within the modal:
 *   idle → input_record → timing_wait → timing_record → done
 */
export default function CalibrationModal({ isOpen, bpm, deviceId, onComplete, onClose }) {
  const [phase,      setPhase]      = useState('idle')
  const [countdown,  setCountdown]  = useState(0)
  const [timeLeft,   setTimeLeft]   = useState(0)
  const [stepIdx,    setStepIdx]    = useState(0)
  const [results,    setResults]    = useState(null)  // { inputCal, timingCal }
  const [err,        setErr]        = useState(null)

  const recorder       = useCalRecorder(deviceId)
  const clickEnabled   = phase === 'timing_record'
  useClickTrack(bpm, clickEnabled)

  const timerRef = useRef(null)

  // Reset when modal opens
  useEffect(() => {
    if (isOpen) {
      setPhase('idle')
      setStepIdx(0)
      setResults(null)
      setErr(null)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [isOpen])

  // ── Step 1: Input calibration ──────────────────────────────────────────────
  const startInputCal = useCallback(async () => {
    setErr(null)
    setPhase('input_countdown')
    setStepIdx(1)

    // 2-second countdown before recording
    let c = 2
    setCountdown(c)
    await new Promise(resolve => {
      timerRef.current = setInterval(() => {
        c -= 1
        setCountdown(c)
        if (c <= 0) { clearInterval(timerRef.current); resolve() }
      }, 1000)
    })

    // Record 2.5 s: first 500 ms = silence (noise floor), then user plays a note
    setPhase('input_record')
    let sampleRate
    try { sampleRate = await recorder.start() } catch (e) {
      setErr(`Microphone error: ${e.message}`)
      setPhase('idle')
      return
    }

    const RECORD_MS = 2500
    let remaining   = RECORD_MS
    setTimeLeft(remaining)
    timerRef.current = setInterval(() => {
      remaining -= 100
      setTimeLeft(Math.max(0, remaining))
    }, 100)

    await new Promise(r => setTimeout(r, RECORD_MS))
    clearInterval(timerRef.current)

    const { samples } = recorder.stop()
    const inputCal    = analyzeInputCalibration(samples, sampleRate)

    setResults(prev => ({ ...prev, inputCal }))
    startTimingCal(inputCal)   // chain into step 2
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder, bpm])

  // ── Step 2: Timing calibration ─────────────────────────────────────────────
  const startTimingCal = useCallback(async (inputCal) => {
    setPhase('timing_wait')
    setStepIdx(2)

    // Give user 1 s to get ready; click track starts when recording begins
    await new Promise(r => setTimeout(r, 1000))

    let sampleRate
    try { sampleRate = await recorder.start() } catch (e) {
      setErr(`Microphone error: ${e.message}`)
      setPhase('idle')
      return
    }

    // Record for 8 beats + 1 beat buffer
    const beatMs    = 60000 / bpm
    const RECORD_MS = Math.round(9 * beatMs)
    let remaining   = RECORD_MS
    setTimeLeft(remaining)
    setPhase('timing_record')

    timerRef.current = setInterval(() => {
      remaining -= 100
      setTimeLeft(Math.max(0, remaining))
    }, 100)

    await new Promise(r => setTimeout(r, RECORD_MS))
    clearInterval(timerRef.current)

    const { samples } = recorder.stop()

    // Reuse detectNotes to find the played note times
    const { notes } = detectNotes(samples, sampleRate, bpm)
    const noteTimes = notes.map(n => n.time_s)

    const timingCal = analyzeTimingCalibration(noteTimes, bpm, samples.length / sampleRate)

    setResults(prev => {
      const merged = { inputCal: prev?.inputCal ?? inputCal, timingCal }
      // Persist both — caller handles saving to localStorage and state
      return merged
    })
    setPhase('done')
    setStepIdx(3)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder, bpm])

  const handleConfirm = () => {
    if (results) onComplete(results)
    else onClose()
  }

  if (!isOpen) return null

  // ── Render ─────────────────────────────────────────────────────────────────
  const progressBar = (ms, totalMs) => {
    const pct = Math.max(0, Math.min(100, ((totalMs - ms) / totalMs) * 100))
    return (
      <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginTop: 12 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width 0.1s linear' }} />
      </div>
    )
  }

  const stepDot = (i) => (
    <div key={i} style={{
      width: 8, height: 8, borderRadius: '50%',
      background: i <= stepIdx ? 'var(--accent)' : 'var(--border)',
      transition: 'background 0.3s',
    }} />
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      background: 'rgba(0,0,0,0.72)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
    }}>
      <div style={{
        width: '100%', maxWidth: 420,
        background: 'var(--bg-panel, #181008)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: '28px 28px 24px',
        position: 'relative',
      }}>
        {/* Close */}
        <button
          onClick={onClose}
          style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-3)', fontSize: '1.2rem', cursor: 'pointer', lineHeight: 1 }}
        >×</button>

        {/* Step dots */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
          {STEP_LABELS.map((_, i) => stepDot(i))}
        </div>

        {/* ── idle ── */}
        {phase === 'idle' && (
          <>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 8 }}>
              Calibrate your setup
            </h2>
            <p style={{ fontSize: '0.84rem', color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 8 }}>
              Two quick steps — takes under 10 seconds:
            </p>
            <ol style={{ fontSize: '0.82rem', color: 'var(--text-2)', lineHeight: 1.8, paddingLeft: 18, marginBottom: 20 }}>
              <li><strong>Mic level</strong> — stay silent 0.5 s, then play one clean note</li>
              <li><strong>Timing</strong> — play 8 notes with the click track</li>
            </ol>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-3)', marginBottom: 20 }}>
              BPM: <strong>{bpm}</strong> · Results saved for all future sessions.
            </p>
            {err && (
              <p style={{ fontSize: '0.8rem', color: 'var(--red)', marginBottom: 12 }}>{err}</p>
            )}
            <button className="btn-primary" onClick={startInputCal} style={{ width: '100%', padding: '10px' }}>
              Start calibration
            </button>
          </>
        )}

        {/* ── input countdown ── */}
        {phase === 'input_countdown' && (
          <>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 12 }}>
              Step 1 — Mic level
            </h2>
            <p style={{ fontSize: '0.88rem', color: 'var(--text-2)', lineHeight: 1.6 }}>
              Get ready…
            </p>
            <div style={{ fontSize: '3rem', textAlign: 'center', color: 'var(--accent)', margin: '20px 0', fontWeight: 700 }}>
              {countdown}
            </div>
          </>
        )}

        {/* ── input recording ── */}
        {phase === 'input_record' && (
          <>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 12 }}>
              Step 1 — Mic level
            </h2>
            <p style={{ fontSize: '0.88rem', color: 'var(--accent)', lineHeight: 1.6, fontWeight: 500 }}>
              {timeLeft > 2000 ? '🤫 Stay quiet…' : '🎸 Play a single note now!'}
            </p>
            {progressBar(timeLeft, 2500)}
            <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginTop: 10 }}>
              {(timeLeft / 1000).toFixed(1)} s remaining
            </p>
          </>
        )}

        {/* ── timing wait ── */}
        {phase === 'timing_wait' && (
          <>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 12 }}>
              Step 2 — Timing
            </h2>
            <p style={{ fontSize: '0.88rem', color: 'var(--text-2)', lineHeight: 1.6 }}>
              Click track starting… get ready to play 8 notes.
            </p>
          </>
        )}

        {/* ── timing recording ── */}
        {phase === 'timing_record' && (
          <>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 12 }}>
              Step 2 — Timing
            </h2>
            <p style={{ fontSize: '0.88rem', color: 'var(--accent)', lineHeight: 1.6, fontWeight: 500 }}>
              🥁 Play 8 notes with the click!
            </p>
            {progressBar(timeLeft, Math.round(9 * 60000 / bpm))}
            <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginTop: 10 }}>
              {(timeLeft / 1000).toFixed(1)} s remaining · BPM {bpm}
            </p>
          </>
        )}

        {/* ── done ── */}
        {phase === 'done' && results && (
          <>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 16 }}>
              Calibration complete ✓
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
              {results.inputCal && (
                <div style={{ fontSize: '0.82rem', color: 'var(--text-2)', background: 'var(--bg-deep)', borderRadius: 8, padding: '10px 14px' }}>
                  <span style={{ color: 'var(--text-3)' }}>Noise floor</span>
                  <strong style={{ float: 'right', color: 'var(--text-1)' }}>
                    {results.inputCal.noiseFloorDb.toFixed(0)} dB
                  </strong>
                  <br />
                  <span style={{ color: 'var(--text-3)' }}>Onset threshold</span>
                  <strong style={{ float: 'right', color: 'var(--accent)' }}>
                    {results.inputCal.thresholdDb.toFixed(0)} dB
                  </strong>
                </div>
              )}
              {results.timingCal && (
                <div style={{ fontSize: '0.82rem', color: 'var(--text-2)', background: 'var(--bg-deep)', borderRadius: 8, padding: '10px 14px' }}>
                  <span style={{ color: 'var(--text-3)' }}>Timing bias</span>
                  <strong style={{ float: 'right', color: results.timingCal.avgOffsetMs === 0 ? 'var(--green)' : 'var(--yellow)' }}>
                    {results.timingCal.avgOffsetMs > 0 ? '+' : ''}{results.timingCal.avgOffsetMs} ms
                    &nbsp;({results.timingCal.avgOffsetMs < -15 ? 'tends early' : results.timingCal.avgOffsetMs > 15 ? 'tends late' : 'on time'})
                  </strong>
                  <br />
                  <span style={{ color: 'var(--text-3)' }}>Notes detected</span>
                  <strong style={{ float: 'right', color: 'var(--text-1)' }}>
                    {results.timingCal.noteCount}
                  </strong>
                </div>
              )}
            </div>
            <button className="btn-primary" onClick={handleConfirm} style={{ width: '100%', padding: '10px' }}>
              Save &amp; start playing
            </button>
          </>
        )}
      </div>
    </div>
  )
}
