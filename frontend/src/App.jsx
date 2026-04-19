import { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'
import { SignInButton, SignedIn, SignedOut, UserButton, useAuth } from '@clerk/clerk-react'
import './App.css'

// ── Web Audio Metronome ───────────────────────────────────────────────────────
function useMetronome(bpm, enabled) {
  const ctxRef      = useRef(null)
  const nextTickRef = useRef(0)
  const beatRef     = useRef(0)
  const timerRef    = useRef(null)
  const bpmRef      = useRef(bpm)
  const [beat, setBeat] = useState(-1)

  useEffect(() => { bpmRef.current = bpm }, [bpm])

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) clearInterval(timerRef.current)
      setBeat(-1)
      return
    }
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      ctxRef.current = new (window.AudioContext || window.webkitAudioContext)()
    }
    const ctx = ctxRef.current
    if (ctx.state === 'suspended') ctx.resume()

    nextTickRef.current = ctx.currentTime + 0.05
    beatRef.current = 0

    const LOOKAHEAD = 0.1
    const SCHEDULE_MS = 25

    function scheduleTick() {
      const interval = 60 / bpmRef.current
      while (nextTickRef.current < ctx.currentTime + LOOKAHEAD) {
        const t = nextTickRef.current
        const isAccent = beatRef.current === 0
        const freq = isAccent ? 1760 : 880
        const gain = isAccent ? 0.55 : 0.35
        const dur  = isAccent ? 0.06 : 0.04

        const osc = ctx.createOscillator()
        const env = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, t)
        env.gain.setValueAtTime(gain, t)
        env.gain.exponentialRampToValueAtTime(0.001, t + dur)
        osc.connect(env)
        env.connect(ctx.destination)
        osc.start(t)
        osc.stop(t + dur)

        const vb = beatRef.current
        const delay = Math.max(0, (t - ctx.currentTime) * 1000)
        setTimeout(() => setBeat(vb), delay)

        beatRef.current = (beatRef.current + 1) % 4
        nextTickRef.current += interval
      }
    }

    scheduleTick()
    timerRef.current = setInterval(scheduleTick, SCHEDULE_MS)
    return () => { clearInterval(timerRef.current); setBeat(-1) }
  }, [enabled])

  return beat
}

function MetronomeControl({ bpm, running, muted, onToggleMute }) {
  const beat = useMetronome(bpm, running && !muted)
  return (
    <div className="metronome-bar">
      <span className="metro-label">🥁 Metronome</span>
      <div className="metro-dots">
        {[0, 1, 2, 3].map(i => (
          <span key={i} className={`metro-dot${beat === i ? (i === 0 ? ' accent' : ' active') : ''}`} />
        ))}
      </div>
      <button
        className={`metro-mute-btn${muted ? ' muted' : ''}`}
        onClick={onToggleMute}
        title={muted ? 'Unmute metronome' : 'Mute metronome'}
      >
        {muted ? '🔇' : '🔊'}
      </button>
    </div>
  )
}

// ── Web Audio Tuner ───────────────────────────────────────────────────────────
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const A4_FREQ = 440.0

function freqToNote(freq) {
  if (!freq || freq < 20) return null
  const semitones = 12 * Math.log2(freq / A4_FREQ)
  const rounded   = Math.round(semitones)
  const cents     = (semitones - rounded) * 100
  const noteIdx   = ((rounded % 12) + 12 + 9) % 12  // A=0 → C=0
  // midi note 69 = A4; note 60 = C4
  const midi      = 69 + rounded
  const octave    = Math.floor(midi / 12) - 1
  const name      = NOTE_NAMES[midi % 12]
  return { name, octave, cents: Math.round(cents * 10) / 10, freq }
}

// ── Web Audio Recorder (PCM WAV) ────────────────────────────────────────────────────────
function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  
  const writeString = (view, offset, string) => {
    for (let i = 0; i < string.length; i++){
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  
  return new Blob([view], { type: 'audio/wav' });
}

function autocorrelate(buf, sampleRate) {
  const SIZE = buf.length

  // Compute RMS
  let rms = 0
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i]
  rms = Math.sqrt(rms / SIZE)

  // Very low threshold — USB interfaces often deliver quiet signal
  if (rms < 0.001) return { freq: -1, rms }

  // Clip-trim: find where signal crosses 0.2 amplitude
  let r1 = 0, r2 = SIZE - 1
  const clipThreshold = 0.2
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buf[i]) < clipThreshold) { r1 = i; break }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buf[SIZE - i]) < clipThreshold) { r2 = SIZE - i; break }
  }

  const trimmed = buf.slice(r1, r2 + 1)
  const N = trimmed.length
  if (N < 2) return { freq: -1, rms }

  // Autocorrelation
  const c = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N - i; j++) c[i] += trimmed[j] * trimmed[j + i]
  }

  // Find first local minimum (dip), then max after it
  let d = 0
  while (d < N - 1 && c[d] >= c[d + 1]) d++
  let maxVal = -Infinity, maxPos = -1
  for (let i = d; i < N; i++) { if (c[i] > maxVal) { maxVal = c[i]; maxPos = i } }

  if (maxPos <= 0 || maxPos >= N - 1) return { freq: -1, rms }

  // Parabolic interpolation (sub-sample precision)
  const x1 = c[maxPos - 1], x2 = maxVal, x3 = c[maxPos + 1]
  const denom = 2 * x2 - x1 - x3
  const refined = denom === 0 ? maxPos : maxPos - (x3 - x1) / (2 * denom)
  if (refined <= 0) return { freq: -1, rms }

  return { freq: sampleRate / refined, rms }
}

function useTuner(enabled) {
  const [info, setInfo] = useState(null)   // { name, octave, cents, freq, rms } | { error, rms } | { rms } | null
  const streamRef   = useRef(null)
  const animRef     = useRef(null)
  const ctxRef      = useRef(null)

  useEffect(() => {
    if (!enabled) {
      if (animRef.current) cancelAnimationFrame(animRef.current)
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop())
      if (ctxRef.current && ctxRef.current.state !== 'closed') ctxRef.current.close()
      setInfo(null)
      return
    }

    let alive = true
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: 0,
      }
    }
    console.log('[Tuner] Requesting getUserMedia...')
    navigator.mediaDevices.getUserMedia(constraints)
      .then(stream => {
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream

        // Log which track/device was opened
        const track = stream.getAudioTracks()[0]
        console.log('[Tuner] Got audio track:', track.label, track.getSettings())

        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        ctxRef.current = ctx
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 4096   // larger window for better low-freq resolution
        src.connect(analyser)

        const buf = new Float32Array(analyser.fftSize)
        let frameCount = 0
        function tick() {
          if (!alive) return
          analyser.getFloatTimeDomainData(buf)
          const result = autocorrelate(buf, ctx.sampleRate)
          const rms = result.rms

          // Log every 60 frames (~1s) for debugging
          if (++frameCount % 60 === 0) {
            console.log(`[Tuner] RMS=${rms?.toFixed(4)} freq=${ result.freq > 0 ? result.freq.toFixed(1) + 'Hz' : 'none'} sampleRate=${ctx.sampleRate}`)
          }

          if (result.freq > 0) {
            const note = freqToNote(result.freq)
            setInfo(note ? { ...note, rms } : { rms })
          } else {
            setInfo({ rms })   // silence — but still show level
          }
          animRef.current = requestAnimationFrame(tick)
        }
        tick()
      })
      .catch(err => {
        console.error('[Tuner] getUserMedia error:', err.name, err.message)
        setInfo({ error: `${err.name}: ${err.message}` })
      })

    return () => {
      alive = false
      if (animRef.current) cancelAnimationFrame(animRef.current)
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop())
      if (ctxRef.current) ctxRef.current.close().catch(() => {})
    }
  }, [enabled])

  return info
}

function RmsBar({ rms }) {
  // rms is 0–1 float; map to 0–100% with a log scale for better visibility
  const pct = rms != null ? Math.min(100, Math.round(Math.log10(1 + rms * 9999) / 4 * 100)) : 0
  const color = pct > 60 ? '#00e5a0' : pct > 20 ? '#ffd166' : '#555b72'
  return (
    <div className="rms-bar-wrap" title={`Signal level: ${(rms || 0).toFixed(4)}`}>
      <div className="rms-bar-label">Signal</div>
      <div className="rms-bar-track">
        <div className="rms-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="rms-bar-val" style={{ color }}>{pct > 0 ? `${pct}%` : '--'}</div>
    </div>
  )
}

function TunerPanel({ active, onToggle, disabled }) {
  const info = useTuner(active)

  const hasNote  = info && !info.error && info.name
  const cents    = hasNote ? (info.cents ?? 0) : 0
  const inTune   = Math.abs(cents) <= 5
  const close    = Math.abs(cents) <= 15
  const needleColor = inTune ? '#00e5a0' : close ? '#ffd166' : '#ff4d6d'
  const rotation = Math.max(-50, Math.min(50, cents)) * 0.9

  return (
    <div className="card tuner-card">
      <div className="tuner-header">
        <div className="card-title" style={{ marginBottom: 0 }}>🎸 Tuner</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {disabled && <span className="tuner-warn">⚠ Stop recording first</span>}
          <button
            id="tuner-toggle"
            className={`tuner-toggle-btn${active ? ' active' : ''}`}
            onClick={onToggle}
            disabled={disabled}
          >
            {active ? 'Stop' : 'Start'}
          </button>
        </div>
      </div>

      {!active && (
        <div className="tuner-idle">Click <strong>Start</strong> to open the tuner</div>
      )}

      {active && !info && (
        <div className="tuner-idle tuner-listening">Listening — play a note…</div>
      )}

      {active && info?.error && (
        <>
          <div className="tuner-idle" style={{ color: 'var(--red)' }}>
            ⚠ Mic error: {info.error}
          </div>
          <div className="tuner-idle" style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
            Check browser mic permissions · Open DevTools console for details
          </div>
        </>
      )}

      {active && info && !info.error && (
        <div className="tuner-display">
          {/* RMS meter — always visible when active */}
          <RmsBar rms={info.rms} />

          {/* Note name — only when a pitch is detected */}
          {hasNote && (
            <>
              <div className="tuner-note">
                <span className="tuner-note-name" style={{ color: needleColor }}>{info.name}</span>
                <span className="tuner-note-octave">{info.octave}</span>
              </div>

              <div className="tuner-needle-wrap">
                <div className="tuner-scale">
                  {[-50,-25,0,25,50].map(v => (
                    <span key={v} className="tuner-scale-mark" style={{ left: `${50 + v}%` }}>
                      {v === 0 ? '|' : '·'}
                    </span>
                  ))}
                </div>
                <div className="tuner-needle" style={{ transform: `rotate(${rotation}deg)`, background: needleColor }} />
                <div className="tuner-needle-pivot" style={{ background: needleColor }} />
              </div>

              <div className="tuner-cents" style={{ color: needleColor }}>
                {cents > 0 ? `+${cents}` : cents} cents · {info.freq?.toFixed(1)} Hz
              </div>
              <div className={`tuner-verdict ${inTune ? 'in-tune' : ''}`}>
                {inTune ? '✅ In Tune' : cents > 0 ? '▲ Too Sharp' : '▼ Too Flat'}
              </div>
            </>
          )}

          {!hasNote && (
            <div className="tuner-idle tuner-listening" style={{ marginTop: 4 }}>
              Silence detected — play a note
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function fmt(s) {
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(1).padStart(4, '0')
  return m > 0 ? `${m}:${sec}` : `${sec}s`
}

function metricColor(key, value) {
  if (key === 'accuracy_pct') return value >= 85 ? 'good' : value >= 60 ? 'warn' : 'bad'
  if (key === 'on_time_ratio') return value >= 0.8 ? 'good' : value >= 0.5 ? 'warn' : 'bad'
  if (key === 'timing_consistency') return value >= 70 ? 'good' : value >= 40 ? 'warn' : 'bad'
  if (key === 'amplitude_db') return value >= -40 ? 'good' : value >= -55 ? 'warn' : 'bad'
  return 'muted'
}

const SEVERITY_ICON = { high: '🔴', medium: '🟡', low: '🟢' }

// ── Components ────────────────────────────────────────────────────────────────

function StatusBadge({ phase, error }) {
  if (error)      return <span className="status-badge error"><span className="dot"/>Error</span>
  if (phase === 'recording')
    return <span className="status-badge recording"><span className="dot pulse"/>Recording</span>
  if (phase === 'analyzing')
    return <span className="status-badge analyzing"><span className="dot pulse"/>Analyzing…</span>
  if (phase === 'done')
    return <span className="status-badge done"><span className="dot"/>Done</span>
  return <span className="status-badge idle"><span className="dot"/>Ready</span>
}

function MetricCard({ label, value, unit = '', colorKey }) {
  const cls = colorKey ? metricColor(colorKey, value) : 'muted'
  return (
    <div className="metric">
      <div className={`metric-value ${cls}`}>{value}{unit}</div>
      <div className="metric-label">{label}</div>
    </div>
  )
}

function IssueItem({ issue }) {
  return (
    <div className={`issue-item ${issue.severity}`}>
      <span className="issue-icon">{SEVERITY_ICON[issue.severity] || '⚠️'}</span>
      <div className="issue-text">
        <strong>{issue.message}</strong>
        {issue.detail && <span className="issue-detail">{issue.detail}</span>}
      </div>
    </div>
  )
}

function NoteChip({ note }) {
  return (
    <div className="note-chip">
      <span className="note-name">{note.note || '?'}</span>
      {' '}
      <span className="note-meta">
        {note.freq_hz?.toFixed(1)}Hz · {note.time_s?.toFixed(2)}s
      </span>
    </div>
  )
}

function CoachingAdvice({ messages, aiAdvice }) {
  if (!messages?.length && !aiAdvice)
    return <div className="advice-empty">No advice yet — record a session first.</div>

  return (
    <div className="advice-box">
      {aiAdvice && (
        <div className="advice-line ai-advice" style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
          <div style={{ color: 'var(--brand)', marginBottom: 8 }}><strong>🎵 AI Teacher </strong> (Gemini Audio Analysis)</div>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>{aiAdvice}</div>
        </div>
      )}
      {messages?.length > 0 && (
        <div className="advice-line" style={{ fontWeight: 'bold', marginBottom: 8, marginTop: aiAdvice ? 8 : 0 }}>DSP Engine checks:</div>
      )}
      {messages?.map((msg, i) => (
        <div className="advice-line" key={i}><span>{msg}</span></div>
      ))}
    </div>
  )
}

function ResultsPanel({ results }) {
  if (!results || !results.total_notes && results.total_notes !== 0) return null

  const { notes = [], errors = [], messages = [], ai_advice = "" } = results

  return (
    <>
      <div className="card">
        <div className="card-title">📊 Session Metrics</div>
        <div className="metrics-grid">
          <MetricCard label="Notes Detected"   value={notes.length}                                                  colorKey={null} />
          <MetricCard label="Pitch Accuracy"   value={`${(results.accuracy_pct||0).toFixed(0)}`}      unit="%" colorKey="accuracy_pct" />
          <MetricCard label="On-Time Ratio"    value={`${((results.on_time_ratio||0)*100).toFixed(0)}`} unit="%" colorKey="on_time_ratio" />
          <MetricCard label="Timing Error"     value={`${results.timing_error_ms >= 0 ? '+' : ''}${(results.timing_error_ms||0).toFixed(0)}`} unit="ms" colorKey={null} />
          <MetricCard label="Consistency"      value={`${(results.timing_consistency||0).toFixed(0)}`} unit="/100" colorKey="timing_consistency" />
          <MetricCard label="Avg Level"        value={`${(results.amplitude_db || -100).toFixed(0)}`}  unit="dB"  colorKey="amplitude_db" />
        </div>

        {errors.length > 0 && (
          <>
            <div className="card-title">⚡ Detected Issues</div>
            <div className="issues-list">
              {errors.map((e, i) => <IssueItem key={i} issue={e} />)}
            </div>
          </>
        )}

        {notes.length > 0 && (
          <>
            <hr className="section-divider" />
            <div className="card-title">🎵 Notes Played ({notes.length})</div>
            <div className="note-list">
              {notes.slice(0, 24).map((n, i) => <NoteChip key={i} note={n} />)}
              {notes.length > 24 && (
                <div className="note-chip muted">+{notes.length - 24} more</div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-title">🤖 Coaching Advice</div>
        <CoachingAdvice messages={messages} aiAdvice={ai_advice} />
      </div>
    </>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const { getToken } = useAuth()
  const [bpm, setBpm]               = useState(120)
  const [duration, setDuration]     = useState(30)
  const [latencyMs, setLatencyMs]   = useState(0)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [phase, setPhase]           = useState('idle')
  const [elapsed, setElapsed]       = useState(0)
  const [results, setResults]       = useState(null)
  const [error, setError]           = useState(null)
  const [metroMuted, setMetroMuted] = useState(false)
  const [tunerActive, setTunerActive] = useState(false)

  // No device polling needed since we record locally
  
  const inFlightRef = useRef(false)
  const recordingRef = useRef(null)

  const handleRecord = async () => {
    if (phase === 'recording') {
      // ── STOP ──
      setPhase('analyzing')
      if (recordingRef.current) {
        recordingRef.current.stop()
      }
      return
    }

    // ── START ──
    if (inFlightRef.current) return
    inFlightRef.current = true
    setError(null)
    setResults(null)
    setElapsed(0)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      const source = audioCtx.createMediaStreamSource(stream)
      
      const processor = audioCtx.createScriptProcessor(4096, 1, 1)
      const pcmData = []
      
      let startTime = audioCtx.currentTime
      
      processor.onaudioprocess = (e) => {
        const channelData = e.inputBuffer.getChannelData(0)
        pcmData.push(new Float32Array(channelData))
        
        const nowElapsed = audioCtx.currentTime - startTime
        setElapsed(nowElapsed)

        if (nowElapsed >= duration) {
            if (recordingRef.current && recordingRef.current.active) {
                recordingRef.current.stop()
            }
        }
      }

      source.connect(processor)
      processor.connect(audioCtx.destination) // needed for Safari
      
      setPhase('recording')
      
      recordingRef.current = {
        active: true,
        stop: async () => {
            if (!recordingRef.current.active) return;
            recordingRef.current.active = false;
            setPhase('analyzing');
            
            processor.disconnect();
            source.disconnect();
            stream.getTracks().forEach(t => t.stop());
            
            const totalSamples = pcmData.reduce((acc, a) => acc + a.length, 0);
            const allSamples = new Float32Array(totalSamples);
            let offset = 0;
            for(let a of pcmData) {
                allSamples.set(a, offset);
                offset += a.length;
            }
            
            const wavBlob = encodeWAV(allSamples, audioCtx.sampleRate);
            
            const formData = new FormData()
            formData.append('file', wavBlob, 'recording.wav')
            formData.append('bpm', bpm)
            formData.append('latency_ms', latencyMs)
            
            try {
                const jwt = await getToken()
                const { data } = await axios.post('/api/analyze', formData, {
                  headers: { Authorization: `Bearer ${jwt}` }
                })
                setResults(data)
                setPhase('done')
            } catch(e) {
                if (e.response?.status === 403 && e.response?.data?.error === 'LIMIT_REACHED') {
                  setPhase('paywall')
                  return
                }
                setError(e.response?.data?.error || e.message)
                setPhase('idle')
            } finally {
                inFlightRef.current = false
                audioCtx.close().catch(()=>{});
            }
        }
      }

    } catch (e) {
      setError(e.message || 'Could not start browser recording')
      setPhase('idle')
      inFlightRef.current = false
    }
  }

  const pct = clamp((elapsed / duration) * 100, 0, 100)

  return (
    <>
      <SignedOut>
        <div style={{ textAlign: 'center', marginTop: '100px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ fontSize: '48px', marginBottom: '20px' }}>🎸</div>
          <h1>AI Guitar Coach</h1>
          <p style={{ color: '#ccc', maxWidth: '400px', marginBottom: '30px', lineHeight: '1.6' }}>
            Record your playing and get instant, professional feedback powered by advanced DSP and AI analysis.
          </p>
          <SignInButton mode="modal">
            <button className="btn record-btn" style={{ fontSize: '18px', padding: '12px 32px', cursor: 'pointer' }}>Sign In to Start</button>
          </SignInButton>
        </div>
      </SignedOut>
      
      <SignedIn>
      <div style={{ position: 'absolute', top: '16px', right: '16px', zIndex: 100 }}>
        <UserButton />
      </div>
      <div className="app">
        <div className="container">

        {/* ── Header ── */}
        <header className="header">
          <h1>🎸 AI Guitar Coach</h1>
          <p>Record your playing — get instant performance feedback</p>
        </header>

        {/* ── Tuner ── */}
        <TunerPanel
          active={tunerActive}
          onToggle={() => setTunerActive(a => !a)}
          disabled={phase === 'recording'}
        />

        {/* ── Settings ── */}
        <div className="card">
          <div className="card-title">Session Settings</div>
          <div className="controls-grid">

            <div className="field">
              <label>Tempo (BPM)</label>
              <input id="bpm-input" type="number" min="40" max="240" value={bpm}
                onChange={e => setBpm(e.target.value)} disabled={phase === 'recording'} />
            </div>
            <div className="field">
              <label>Max Duration (s)</label>
              <input id="duration-input" type="number" min="5" max="120" value={duration}
                onChange={e => setDuration(e.target.value)} disabled={phase === 'recording'} />
            </div>
          </div>

          {/* Advanced toggle */}
          <button
            className="advanced-toggle"
            onClick={() => setShowAdvanced(v => !v)}
          >
            {showAdvanced ? '▲ Hide advanced' : '▼ Advanced settings'}
          </button>

          {showAdvanced && (
            <div className="advanced-panel">
              <div className="field">
                <label>
                  Latency Compensation (ms)
                  <span className="field-hint"> — subtract from onset times to correct for USB buffer delay</span>
                </label>
                <div className="latency-row">
                  <input
                    id="latency-slider"
                    type="range" min="0" max="200" step="5"
                    value={latencyMs}
                    onChange={e => setLatencyMs(Number(e.target.value))}
                    disabled={phase === 'recording'}
                  />
                  <span className="latency-value">{latencyMs} ms</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Record Control ── */}
        <div className="card">
          <div className="record-section">
            <StatusBadge phase={phase} error={error} />

            <button
              id="record-btn"
              className={`record-btn ${phase}`}
              onClick={handleRecord}
              disabled={phase === 'analyzing'}
            >
              <span className="btn-icon">
                {phase === 'recording' ? '⏹' : phase === 'analyzing' ? '⏳' : '⏺'}
              </span>
              <span className="btn-label">
                {phase === 'recording' ? 'STOP' : phase === 'analyzing' ? 'ANALYZING' : 'RECORD'}
              </span>
            </button>

            <div className={`timer ${phase}`}>
              {phase === 'recording' || phase === 'analyzing' ? fmt(elapsed) : '0.0s'}
            </div>

            {(phase === 'recording' || phase === 'analyzing') && (
              <div className="progress-bar-wrap" style={{ width: '100%' }}>
                <div className="progress-bar" style={{ width: `${pct}%` }} />
              </div>
            )}

            {error && (
              <div className="error-box">
                <div>⚠ {error}</div>
                <a href="/api/debug" target="_blank" className="error-debug-link">
                  View debug info ↗
                </a>
              </div>
            )}
          </div>

          {/* Metronome — visible during recording only */}
          {phase === 'recording' && (
            <MetronomeControl
              bpm={Number(bpm)}
              running={true}
              muted={metroMuted}
              onToggleMute={() => setMetroMuted(m => !m)}
            />
          )}
        </div>

        {/* ── Results ── */}
        <ResultsPanel results={results} />

      </div>

      {phase === 'paywall' && (
         <div className="modal" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000}}>
            <div style={{ background: '#222', padding: '40px', borderRadius: '12px', textAlign: 'center', border: '1px solid #444', maxWidth: '400px' }}>
               <h2 style={{ color: '#ffb300', marginBottom: '16px' }}>Limit Reached</h2>
               <p style={{ color: '#ccc', margin: '0 0 24px', lineHeight: '1.5' }}>
                 You've used your 5 free analyses for today. Upgrade to Pro for unlimited coaching!
               </p>
               <button className="btn record-btn" style={{ padding: '12px 24px', cursor: 'pointer' }} onClick={async () => {
                   try {
                     const jwt = await getToken();
                     const { data } = await axios.post('/api/create-checkout-session', {}, {
                       headers: { Authorization: `Bearer ${jwt}` }
                     });
                     window.location.href = data.url;
                   } catch(err) {
                     setError("Billing system unavailable.");
                     setPhase('idle');
                   }
               }}>Upgrade to Pro</button>
               <div style={{ marginTop: '16px' }}>
                   <button onClick={() => setPhase('idle')} style={{ background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', padding: '8px' }}>
                     Cancel
                   </button>
               </div>
            </div>
         </div>
      )}

    </div>
    </SignedIn>
    </>
  )
}
