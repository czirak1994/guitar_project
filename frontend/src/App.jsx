import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import axios from 'axios'
import { SignInButton, SignUpButton, SignedIn, SignedOut, UserButton, useAuth } from '@clerk/clerk-react'
import { SettingsWidget, LatestStatsWidget, YoutubeWidget, PaywallModal, OnboardingModal, ConversationalChat, GuestLimitModal, SectionTooltip } from './components/AppPanels'
import './App.css'

// Send cookies (anon_token) on every request
axios.defaults.withCredentials = true

// Build Authorization header — empty object when no JWT (guest mode)
function authHeaders(jwt) {
  return jwt ? { Authorization: `Bearer ${jwt}` } : {}
}

// Detect if Clerk is configured. If not, the Clerk hooks/components no-op gracefully.
const CLERK_ENABLED = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// Safe wrapper around useAuth — returns nulls when Clerk is not configured.
function useSafeAuth() {
  if (!CLERK_ENABLED) {
    return { getToken: async () => null, isLoaded: true, isSignedIn: false }
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useAuth()
}

const AI_POLL_INTERVAL_MS = 3000
const AI_POLL_TIMEOUT_MS = 90000

// ── Web Audio Metronome ───────────────────────────────────────────────────────
function useMetronome(bpm, enabled, masterVolume = 0.5) {
  const ctxRef      = useRef(null)
  const nextTickRef = useRef(0)
  const beatRef     = useRef(0)
  const timerRef    = useRef(null)
  const bpmRef      = useRef(bpm)
  const volumeRef   = useRef(masterVolume)
  const [beat, setBeat] = useState(-1)

  useEffect(() => { bpmRef.current = bpm }, [bpm])
  useEffect(() => { volumeRef.current = masterVolume }, [masterVolume])

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
        const gain = (isAccent ? 0.55 : 0.35) * volumeRef.current
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

// ── Web Audio Tuner ───────────────────────────────────────────────────────────
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const A4_FREQ = 440.0

function freqToNote(freq) {
  if (!freq || freq < 20) return null
  const semitones = 12 * Math.log2(freq / A4_FREQ)
  const rounded   = Math.round(semitones)
  const cents     = (semitones - rounded) * 100
  const noteIdx   = ((rounded % 12) + 12 + 9) % 12
  const midi      = 69 + rounded
  const octave    = Math.floor(midi / 12) - 1
  const name      = NOTE_NAMES[midi % 12]
  return { name, octave, cents: Math.round(cents * 10) / 10, freq }
}

function autocorrelate(buf, sampleRate) {
  const SIZE = buf.length
  let rms = 0
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i]
  rms = Math.sqrt(rms / SIZE)

  if (rms < 0.001) return { freq: -1, rms }

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

  const c = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N - i; j++) c[i] += trimmed[j] * trimmed[j + i]
  }

  let d = 0
  while (d < N - 1 && c[d] >= c[d + 1]) d++
  let maxVal = -Infinity, maxPos = -1
  for (let i = d; i < N; i++) { if (c[i] > maxVal) { maxVal = c[i]; maxPos = i } }

  if (maxPos <= 0 || maxPos >= N - 1) return { freq: -1, rms }

  const x1 = c[maxPos - 1], x2 = maxVal, x3 = c[maxPos + 1]
  const denom = 2 * x2 - x1 - x3
  const refined = denom === 0 ? maxPos : maxPos - (x3 - x1) / (2 * denom)
  if (refined <= 0) return { freq: -1, rms }

  return { freq: sampleRate / refined, rms }
}

function useTuner(enabled) {
  const [info, setInfo] = useState(null)
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
    const constraints = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0 } }
    
    navigator.mediaDevices.getUserMedia(constraints)
      .then(stream => {
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream

        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        ctxRef.current = ctx
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 4096
        src.connect(analyser)

        const buf = new Float32Array(analyser.fftSize)
        function tick() {
          if (!alive) return
          analyser.getFloatTimeDomainData(buf)
          const result = autocorrelate(buf, ctx.sampleRate)
          
          if (result.freq > 0) {
            const note = freqToNote(result.freq)
            setInfo(note ? { ...note, rms: result.rms } : { rms: result.rms })
          } else {
            setInfo({ rms: result.rms })
          }
          animRef.current = requestAnimationFrame(tick)
        }
        tick()
      })
      .catch(err => {
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

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  
  const writeString = (view, offset, string) => {
    for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i))
  }
  
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)
  
  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
  }
  return new Blob([view], { type: 'audio/wav' })
}

// ── UI Components ─────────────────────────────────────────────────────────────

function TunerWidget({ active, onToggle, disabled, info }) {
  const hasNote = info && !info.error && !!info.name
  const cents = hasNote ? (info.cents ?? 0) : 0
  const rotation = Math.max(-50, Math.min(50, cents)) * 0.9

  return (
    <div className="widget">
      <div className="widget-title">
        <span>Tuner</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <SectionTooltip text="Real-time chromatic tuner. Shows you which note you're playing and whether you're in tune, sharp (too high), or flat (too low)." />
          <button className="btn" onClick={onToggle} disabled={disabled}>
            {active ? 'Stop Tuner' : 'Start Tuner'}
          </button>
        </div>
      </div>

      {active && info?.error && (
        <div style={{color: 'var(--red)', fontSize: '0.8rem'}}>{info.error}</div>
      )}

      {active && !info?.error && (
        <div className="tuner-compact">
            <div className="tuner-header-row">
              <div className="tuner-readout">
                {hasNote ? (
                  <>
                    <span className="tuner-note-name">{info.name}</span>
                    <span className="tuner-note-octave">{info.octave}</span>
                  </>
                ) : (
                  <span style={{color: 'var(--text-3)', fontFamily: 'monospace'}}>--</span>
                )}
              </div>
              <div className="tuner-status" style={{color: hasNote && Math.abs(cents) <= 5 ? 'var(--accent)' : 'var(--text-3)'}}>
                 {hasNote ? (Math.abs(cents) <= 5 ? 'IN TUNE' : cents > 0 ? 'SHARP' : 'FLAT') : 'LISTENING'}
              </div>
            </div>
            
            <div className="tuner-needle-container">
              {hasNote && (
                 <div className="tuner-needle" style={{ transform: `rotate(${rotation}deg)`, background: Math.abs(cents) <= 5 ? 'var(--accent)' : 'var(--yellow)' }} />
              )}
              <div className="tuner-center-mark" />
            </div>
        </div>
      )}
    </div>
  )
}

// ── Live Fretboard Visualizer ─────────────────────────────────────────────────
const FRET_DISPLAY_STRINGS = [64, 59, 55, 50, 45, 40] // high e → low E
const FRET_STRING_NAMES   = ['e', 'B', 'G', 'D', 'A', 'E']
const FRET_COUNT = 24

function FretboardVisualizer({ noteInfo, active, onToggle }) {
  const activeNote = (noteInfo && !noteInfo.error) ? (noteInfo.name ?? null) : null
  const cents = noteInfo?.cents ?? 0
  const inTune = activeNote && Math.abs(cents) <= 8

  // SVG layout — wider string spacing for readable dots
  const SY = [20, 38, 56, 74, 92, 110]          // y per string (high e … low E), 18px spacing
  const NUT_X = 44                               // nut line x
  const FRET_W = 30                              // px per fret (narrower for 24 frets)
  const OPEN_X = 28                              // open-string dot x
  const BOARD_END = NUT_X + FRET_COUNT * FRET_W // 764
  const MID_Y = (SY[0] + SY[5]) / 2            // board vertical center
  const VH = 130                                 // viewBox height

  function noteAt(si, fret) {
    return NOTE_NAMES[(FRET_DISPLAY_STRINGS[si] + fret) % 12]
  }

  function dotX(fret) {
    return fret === 0 ? OPEN_X : NUT_X + (fret - 0.5) * FRET_W
  }

  const activeDots = []
  if (activeNote) {
    for (let si = 0; si < 6; si++) {
      for (let f = 0; f <= FRET_COUNT; f++) {
        if (noteAt(si, f) === activeNote) activeDots.push({ si, f })
      }
    }
  }

  return (
    <div className="fretboard-widget">
      <div className="fretboard-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="fretboard-label">Live Fretboard</span>
          <SectionTooltip text="Visualizes where your current note sits on the guitar neck in real time. Works while the Tuner is active." />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {activeNote && (
            <span className="fretboard-active-note" style={{ color: inTune ? 'var(--accent)' : 'var(--text-2)' }}>
              {activeNote} {inTune ? '✓' : (cents > 0 ? '▲' : '▼')}
            </span>
          )}
          {active && !activeNote && (
            <span className="fretboard-hint">listening…</span>
          )}
          <button className="btn" style={{ padding: '3px 10px', fontSize: '0.75rem' }} onClick={onToggle}>
            {active ? 'Stop' : 'Start'}
          </button>
        </div>
      </div>

      <div className="fretboard-svg-wrap">
        <svg width="100%" height={VH} viewBox={`0 0 780 ${VH}`} preserveAspectRatio="xMidYMid meet">
          {/* Board background */}
          <rect x={NUT_X} y={SY[0] - 6} width={FRET_COUNT * FRET_W} height={SY[5] - SY[0] + 12}
            fill="rgba(20,14,8,0.6)" rx={4} />

          {/* Strings */}
          {FRET_DISPLAY_STRINGS.map((_, i) => (
            <line key={i} x1={20} y1={SY[i]} x2={BOARD_END} y2={SY[i]}
              stroke="rgba(200,165,90,0.45)" strokeWidth={0.6 + i * 0.3} />
          ))}

          {/* Fret lines */}
          {Array.from({ length: FRET_COUNT }, (_, i) => i + 1).map(f => (
            <line key={f} x1={NUT_X + f * FRET_W} y1={SY[0] - 6} x2={NUT_X + f * FRET_W} y2={SY[5] + 6}
              stroke="rgba(180,140,80,0.22)" strokeWidth={1} />
          ))}

          {/* Nut */}
          <line x1={NUT_X} y1={SY[0] - 6} x2={NUT_X} y2={SY[5] + 6}
            stroke="rgba(230,200,130,0.7)" strokeWidth={4} strokeLinecap="round" />

          {/* Inlay dots */}
          {[3, 5, 7, 9, 15, 17, 19, 21].map(f => (
            <circle key={f} cx={NUT_X + (f - 0.5) * FRET_W} cy={MID_Y} r={3.5}
              fill="rgba(180,140,80,0.2)" />
          ))}
          {[12, 24].map(f => (
            <g key={f}>
              <circle cx={NUT_X + (f - 0.5) * FRET_W} cy={MID_Y - 10} r={3.5} fill="rgba(180,140,80,0.2)" />
              <circle cx={NUT_X + (f - 0.5) * FRET_W} cy={MID_Y + 10} r={3.5} fill="rgba(180,140,80,0.2)" />
            </g>
          ))}

          {/* Fret number labels */}
          {[3, 5, 7, 9, 12, 15, 17, 19, 21, 24].map(f => (
            <text key={f} x={NUT_X + (f - 0.5) * FRET_W} y={VH - 4} fontSize={8.5}
              fill="rgba(120,90,50,0.8)" textAnchor="middle" fontFamily="monospace">{f}</text>
          ))}

          {/* String name labels */}
          {FRET_STRING_NAMES.map((n, i) => (
            <text key={i} x={11} y={SY[i] + 4} fontSize={11}
              fill="rgba(150,115,70,0.8)" textAnchor="middle" fontFamily="monospace">{n}</text>
          ))}

          {/* Active note dots */}
          {activeDots.map(({ si, f }) => {
            const cx = dotX(f)
            const cy = SY[si]
            return (
              <g key={`${si}-${f}`}>
                {/* outer glow */}
                <circle cx={cx} cy={cy} r={11}
                  fill={inTune ? 'var(--accent)' : 'rgba(245,166,35,0.18)'} opacity={inTune ? 0.18 : 1} />
                {/* main dot */}
                <circle cx={cx} cy={cy} r={8}
                  fill={inTune ? 'var(--accent)' : 'rgba(245,120,30,0.82)'}
                  stroke={inTune ? 'rgba(255,230,140,0.85)' : 'rgba(245,166,35,0.5)'}
                  strokeWidth={1.5} />
                {/* note label */}
                <text x={cx} y={cy + 3.5} fontSize={8} fill={inTune ? '#120d04' : '#f0e6d3'}
                  textAnchor="middle" fontFamily="monospace" fontWeight="bold">
                  {NOTE_NAMES[(FRET_DISPLAY_STRINGS[si] + f) % 12]}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const { getToken, isLoaded, isSignedIn } = useSafeAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [bpm, setBpm] = useState(120)
  const [metroVolume, setMetroVolume] = useState(0.5)
  const [backingVolume, setBackingVolume] = useState(0.5)

  // Detect Stripe redirect params — params live in the hash with HashRouter
  const stripeParams = new URLSearchParams(location.search)
  const [stripeNotice, setStripeNotice] = useState(
    stripeParams.get('success') === 'true' ? 'success' :
    stripeParams.get('canceled') === 'true' ? 'canceled' : null
  )
  useEffect(() => {
    if (stripeNotice) {
      navigate('/', { replace: true })
      const t = setTimeout(() => setStripeNotice(null), 6000)
      return () => clearTimeout(t)
    }
  }, [stripeNotice])
  
  const [phase, setPhase] = useState('idle') // idle | countdown | recording | review | paywall | guest_limit
  const [countdown, setCountdown] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [chatMessages, setChatMessages] = useState([])
  const [activeChatSessionId, setActiveChatSessionId] = useState(null)
  const [latestMetrics, setLatestMetrics] = useState(null)
  const [profile, setProfile] = useState(null)
  const [usage, setUsage] = useState(null) // { is_guest, plan, remaining_today, daily_limit }
  const [pendingAudio, setPendingAudio] = useState(null)
  const [backingTrack, setBackingTrack] = useState(null)
  const [focusArea, setFocusArea] = useState('overall')
  const [guitarStyle, setGuitarStyle] = useState('')
  const [scaleKey, setScaleKey] = useState('')
  const [rhythmInfo, setRhythmInfo] = useState('')
  
  const playerRef = useRef(null)
  
  const [tunerActive, setTunerActive] = useState(false)
  const [fretboardActive, setFretboardActive] = useState(false)
  const [metroMuted, setMetroMuted] = useState(false)
  const [metroEnabled, setMetroEnabled] = useState(false)
  
  const beat = useMetronome(bpm, (metroEnabled || phase === 'recording') && !metroMuted, metroVolume)
  const tunerInfo = useTuner(tunerActive)
  const fretboardInfo = useTuner(fretboardActive)

  const inFlightRef = useRef(false)
  const recordingRef = useRef(null)

  useEffect(() => {
    if (playerRef.current) {
        playerRef.current.setVolume(backingVolume * 100);
    }
  }, [backingVolume])

  useEffect(() => {
    if (!isLoaded) return
    if (isSignedIn) {
      // Migrate any guest sessions, then fetch profile + usage with auth
      getToken().then(async (jwt) => {
        try {
          await axios.post('/api/auth/migrate-guest', {}, { headers: authHeaders(jwt) })
        } catch { /* non-fatal */ }
        try {
          const res = await axios.get('/api/profile', { headers: authHeaders(jwt) })
          setProfile(res.data)
        } catch (err) { console.error(err) }
        try {
          const res = await axios.get('/api/usage', { headers: authHeaders(jwt) })
          setUsage(res.data)
        } catch { /* ignore */ }
      })
    } else {
      // Guest — no profile, but fetch usage so header shows remaining count
      axios.get('/api/usage')
        .then(res => setUsage(res.data))
        .catch(() => {})
    }
  }, [isLoaded, isSignedIn, getToken])

  const handleOnboardingSubmit = async ({ skill, goal, language }) => {
     try {
       const jwt = await getToken()
       const { data } = await axios.post('/api/profile', { skill_level: skill, goal: goal, language: language }, {
         headers: authHeaders(jwt)
       })
       setProfile(data)
     } catch (e) {
       alert("Error saving profile")
     }
  }

  const handleRecord = async () => {
    if (phase === 'recording') {
      setPhase('idle')
      if (recordingRef.current) recordingRef.current.stop()
      return
    }

    if (inFlightRef.current) return
    inFlightRef.current = true
    setElapsed(0)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      
      setPhase('countdown')
      let count = 3
      setCountdown(count)
      
      const timer = setInterval(() => {
         count -= 1
         setCountdown(count)
         if (count <= 0) {
            clearInterval(timer)
            startActualRecord(stream, audioCtx)
         }
      }, 1000)

    } catch (e) {
      alert(e.message || 'Could not start recording')
      setPhase('idle')
      inFlightRef.current = false
    }
  }

  const startActualRecord = (stream, audioCtx) => {
      const source = audioCtx.createMediaStreamSource(stream)
      const processor = audioCtx.createScriptProcessor(4096, 1, 1)
      const pcmData = []
      
      let startTime = audioCtx.currentTime
      
      processor.onaudioprocess = (e) => {
        const channelData = e.inputBuffer.getChannelData(0)
        pcmData.push(new Float32Array(channelData))
        setElapsed(audioCtx.currentTime - startTime)
      }

      source.connect(processor)
      processor.connect(audioCtx.destination)
      
      setPhase('recording')
      if (backingTrack && playerRef.current) {
          playerRef.current.seekTo(0);
          playerRef.current.playVideo();
      }
      
      recordingRef.current = {
        active: true,
        stop: async () => {
            if (!recordingRef.current.active) return
            recordingRef.current.active = false
            if (backingTrack && playerRef.current) playerRef.current.pauseVideo();
            
            processor.disconnect()
            source.disconnect()
            stream.getTracks().forEach(t => t.stop())
            
            const totalSamples = pcmData.reduce((acc, a) => acc + a.length, 0)
            const allSamples = new Float32Array(totalSamples)
            let offset = 0
            for(let a of pcmData) {
                allSamples.set(a, offset)
                offset += a.length
            }
            
            const wavBlob = encodeWAV(allSamples, audioCtx.sampleRate)
            const wavUrl = URL.createObjectURL(wavBlob)
            
            setPendingAudio({ blob: wavBlob, url: wavUrl })
            setPhase('review')
            inFlightRef.current = false
            audioCtx.close().catch(()=>{})
        }
      }
  }

    const pollChatAI = (sessionId, jwt, aiMsgId) => {
    const startedAt = Date.now()
    const timer = setInterval(async () => {
      try {
        if (Date.now() - startedAt > AI_POLL_TIMEOUT_MS) {
          clearInterval(timer)
          inFlightRef.current = false
          setChatMessages(prev => prev.map(m => m.id === aiMsgId ? {
            ...m, status: 'error', text: 'AI analysis timed out. Please try again.',
          } : m))
          return
        }
        const { data } = await axios.get(`/api/session/${sessionId}`, { headers: authHeaders(jwt) })
        if (data.ai_status === 'completed' || data.ai_status === 'failed') {
          clearInterval(timer)
          inFlightRef.current = false
          setActiveChatSessionId(sessionId)
          if (data.ai_status === 'completed') {
            setChatMessages(prev => prev.map(m => m.id === aiMsgId ? {
              ...m, status: 'done', ai_data: data.ai_advice, text: null,
            } : m))
          } else {
            setChatMessages(prev => prev.map(m => m.id === aiMsgId ? {
              ...m, status: 'error', text: 'AI analysis failed. Please try again.',
            } : m))
          }
        }
      } catch (e) {
        clearInterval(timer)
        inFlightRef.current = false
      }
    }, AI_POLL_INTERVAL_MS)
  }

  const handleChatSend = async (text, audio) => {
    if (!text && !audio) return

    const userMsgId = `u-${Date.now()}`
    const aiMsgId = `a-${Date.now() + 1}`

    const lowerText = (text || '').toLowerCase()
    const isFeedback = lowerText.startsWith('feedback:') || lowerText.startsWith('bug:')

    const audioUrl = audio?.url || null
    const audioBlob = audio?.blob || null

    if (audio) {
      setPendingAudio(null)
      setPhase('idle')
    }

    setChatMessages(prev => [...prev, { id: userMsgId, role: 'user', text: text || null, audio_url: audioUrl }])
    setChatMessages(prev => [...prev, { id: aiMsgId, role: 'assistant', status: 'analyzing', text: null, ai_data: null }])

    try {
      const jwt = await getToken()

      if (isFeedback) {
        axios.post('/api/feedback', { message: text, session_id: activeChatSessionId }, {
          headers: authHeaders(jwt),
        }).catch(() => {})
      }

      if (audioBlob) {
        inFlightRef.current = true
        const formData = new FormData()
        formData.append('file', audioBlob, 'recording.wav')
        formData.append('bpm', bpm)
        if (backingTrack) formData.append('backing_track_url', backingTrack.url)
        if (text) formData.append('problem', text)
        formData.append('focus', focusArea)
        formData.append('style', guitarStyle)
        formData.append('scale_or_key', scaleKey)
        formData.append('rhythm_info', rhythmInfo)

        const { data } = await axios.post('/api/analyze', formData, {
          headers: authHeaders(jwt),
        })

        if (data.streak_days !== undefined && data.streak_days !== null) {
          setProfile(p => p ? ({ ...p, streak_days: data.streak_days, current_focus: data.current_focus }) : p)
        }
        if (data.remaining_today !== undefined) {
          setUsage(u => ({ ...(u || {}), is_guest: data.is_guest, remaining_today: data.remaining_today }))
        }
        setLatestMetrics({
          accuracy_pct: data.accuracy_pct,
          on_time_ratio: data.on_time_ratio,
          timing_error_ms: data.timing_error_ms,
          amplitude_db: data.amplitude_db,
          bpm,
        })

        if (data.status === 'processing_ai' || data.status === 'completed') {
          // 'completed' = silent audio: backend saved AIFeedback synchronously, poll will return immediately
          pollChatAI(data.session_id, jwt, aiMsgId)
        } else {
          inFlightRef.current = false
          setChatMessages(prev => prev.map(m => m.id === aiMsgId ? {
            ...m, status: 'error', text: 'Recording received but no AI response. Please try again.',
          } : m))
        }
      } else {
        const history = chatMessages
          .filter(m => m.status !== 'analyzing')
          .map(m => ({
            role: m.role,
            content: m.ai_data ? (m.ai_data.diagnosis || JSON.stringify(m.ai_data)) : (m.text || ''),
          }))

        let res
        if (activeChatSessionId) {
          res = await axios.post(`/api/session/${activeChatSessionId}/chat`, { message: text }, {
            headers: authHeaders(jwt),
          })
        } else {
          res = await axios.post('/api/chat', {
            message: text,
            history,
            context: { focus: focusArea, style: guitarStyle, scale_or_key: scaleKey, rhythm_info: rhythmInfo },
          }, { headers: authHeaders(jwt) })
        }

        setChatMessages(prev => prev.map(m => m.id === aiMsgId ? {
          ...m, status: 'done', text: res.data.response,
        } : m))
      }
    } catch (e) {
      const errCode = e.response?.data?.error
      if (e.response?.status === 403 && errCode === 'GUEST_LIMIT_REACHED') {
        setUsage(u => ({ ...(u || {}), remaining_today: 0 }))
        setPhase('guest_limit')
        setChatMessages(prev => prev.filter(m => m.id !== aiMsgId))
      } else if (e.response?.status === 403 && errCode === 'LIMIT_REACHED') {
        setPhase('paywall')
        setChatMessages(prev => prev.filter(m => m.id !== aiMsgId))
      } else {
        setChatMessages(prev => prev.map(m => m.id === aiMsgId ? {
          ...m, status: 'error', text: e.response?.data?.error || 'Something went wrong. Please try again.',
        } : m))
      }
      inFlightRef.current = false
    }
  }

  const handleDiscardTake = () => {
    if (pendingAudio?.url) URL.revokeObjectURL(pendingAudio.url)
    setPendingAudio(null)
    setPhase('idle')
  }

  const showOnboarding = isSignedIn && profile && !profile.skill_level
  const isGuest = !isSignedIn

  return (
    <>
      <div className="app">
          <OnboardingModal isOpen={showOnboarding} onSubmit={handleOnboardingSubmit} />

          {phase === 'countdown' && (
            <div className="countdown-overlay">
              <div className="countdown-number">{countdown}</div>
              <div className="countdown-text">Get Ready…</div>
            </div>
          )}

          <header className="app-header">
            <div className="app-title">ToneSense</div>
            <div className="header-right">
              {usage && usage.remaining_today !== null && usage.remaining_today !== undefined && (
                <span
                  className="usage-pill"
                  style={{
                    fontSize: '0.78rem',
                    color: usage.remaining_today === 0 ? 'var(--red)' : 'var(--text-2)',
                    padding: '4px 10px',
                    border: '1px solid var(--border)',
                    borderRadius: 999,
                    background: 'var(--bg-deep)',
                  }}
                  title={isGuest
                    ? `Guests get ${usage.daily_limit || 3} recordings/day. Sign up for more.`
                    : `Free plan: ${usage.daily_limit || 5} recordings/day. Upgrade to PRO for unlimited.`}
                >
                  {usage.remaining_today} {usage.remaining_today === 1 ? 'recording' : 'recordings'} left today
                </span>
              )}
              {isGuest && CLERK_ENABLED && (
                <SignInButton mode="modal">
                  <button className="btn" style={{ padding: '6px 14px', fontSize: '0.84rem' }}>Sign in</button>
                </SignInButton>
              )}
              {isGuest && CLERK_ENABLED && (
                <SignUpButton mode="modal">
                  <button className="btn btn-accent" style={{ padding: '6px 14px', fontSize: '0.84rem' }}>Sign up</button>
                </SignUpButton>
              )}
              {isSignedIn && profile && profile.plan === 'free' && (
                <button
                  className="upgrade-btn"
                  onClick={async () => {
                    try {
                      const jwt = await getToken()
                      const { data } = await axios.post('/api/create-checkout-session', {}, { headers: authHeaders(jwt) })
                      window.location.href = data.url
                    } catch { /* silent */ }
                  }}
                >
                  ⚡ Upgrade to PRO
                </button>
              )}
              {isSignedIn && (
                <>
                  <button className="header-profile-btn" onClick={() => navigate('/profile')}>⚙ Profile</button>
                  <UserButton appearance={{ elements: { userButtonAvatarBox: { width: 28, height: 28 } } }} />
                </>
              )}
            </div>
          </header>

          {stripeNotice && (
            <div style={{
              background: stripeNotice === 'success' ? 'rgba(76, 175, 106, 0.12)' : 'rgba(180, 140, 80, 0.12)',
              border: `1px solid ${stripeNotice === 'success' ? 'rgba(76,175,106,0.3)' : 'rgba(180,140,80,0.3)'}`,
              color: stripeNotice === 'success' ? 'var(--green)' : 'var(--text-2)',
              padding: '10px 20px',
              fontSize: '0.84rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexShrink: 0,
            }}>
              <span>
                {stripeNotice === 'success'
                  ? '✓ Upgrade successful! Your account is now PRO.'
                  : 'Checkout cancelled — you remain on the Free plan.'}
              </span>
              <button onClick={() => setStripeNotice(null)} style={{ background:'none', border:'none', color:'inherit', cursor:'pointer', fontSize:'1rem', padding:'0 4px' }}>×</button>
            </div>
          )}

          <div className="workspace">
            {/* Left Panel: Context & Controls */}
            <div className="controls-panel" style={{ pointerEvents: phase === 'countdown' ? 'none' : 'auto' }}>

              <div className="widget" style={{ paddingBottom: '18px' }}>
                <div className="widget-title">
                  <span>Session Context</span>
                  <SectionTooltip text="Tell the AI what you're working on. The more context you give, the more personalized and useful your coaching feedback will be." />
                </div>
                <div className="controls-grid">
                  <div className="field">
                    <label>Focus</label>
                    <select value={focusArea} onChange={(e) => setFocusArea(e.target.value)}>
                      <option value="overall">Overall</option>
                      <option value="Timing">Timing</option>
                      <option value="Rhythm">Rhythm</option>
                      <option value="Technique">Technique</option>
                      <option value="Tone">Tone</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Style</label>
                    <input className="input-field" type="text" placeholder="e.g. Metal, Blues, Jazz" value={guitarStyle} onChange={(e) => setGuitarStyle(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Scale / Key <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.78rem' }}>(optional)</span></label>
                    <input className="input-field" type="text" placeholder="e.g. A minor, C major" value={scaleKey} onChange={(e) => setScaleKey(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Rhythm / Tempo <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.78rem' }}>(optional)</span></label>
                    <input className="input-field" type="text" placeholder="e.g. 16th note at 90 BPM" value={rhythmInfo} onChange={(e) => setRhythmInfo(e.target.value)} />
                  </div>
                </div>
              </div>

              {profile && profile.skill_level && (
                <div className="widget dashboard-habit-widget">
                  <div className="habit-header">
                    <span className="habit-streak">🔥 Streak: {profile.streak_days || 0} Days</span>
                    <span className="habit-focus-label">Current Focus</span>
                  </div>
                  <div className="habit-focus-text">{profile.current_focus}</div>
                </div>
              )}

              <div className="widget" style={{ paddingBottom: '16px' }}>
                <div className="widget-title">
                  <span>Metronome</span>
                  <SectionTooltip text="Practice to a steady click track. Set your tempo (BPM) and volume, then press Start. The metronome also runs automatically while recording." />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div className="metro-dots">
                    {[0, 1, 2, 3].map(i => (
                      <span key={i} className={`metro-dot ${beat === i ? (i === 0 ? 'accent' : 'active') : ''}`} />
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn" style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                      onClick={() => setMetroEnabled(e => !e)}>
                      {metroEnabled ? 'Stop' : 'Start'}
                    </button>
                    <button className="btn" style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                      onClick={() => setMetroMuted(m => !m)}>
                      {metroMuted ? 'Unmute' : 'Mute'}
                    </button>
                  </div>
                </div>
                <div className="metro-settings">
                  <div className="field">
                    <label>Tempo (BPM)</label>
                    <input type="number" min="40" max="240" value={bpm} onChange={e => setBpm(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Metronome Vol</label>
                    <input type="range" min="0" max="1" step="0.05" value={metroVolume} onChange={e => setMetroVolume(parseFloat(e.target.value))} />
                  </div>
                </div>
              </div>

              <TunerWidget active={tunerActive} onToggle={() => setTunerActive(a => !a)} disabled={phase === 'recording' || phase === 'countdown'} info={tunerInfo} />
              <YoutubeWidget backingTrack={backingTrack} setBackingTrack={setBackingTrack} disabled={phase === 'recording'} playerRef={playerRef} backingVolume={backingVolume} setBackingVolume={setBackingVolume} />
              <LatestStatsWidget result={latestMetrics} />
            </div>

            {/* Right column: Fretboard + Chat */}
            <div className="right-column">
              <FretboardVisualizer noteInfo={fretboardInfo} active={fretboardActive} onToggle={() => setFretboardActive(a => !a)} />
              <ConversationalChat
                messages={chatMessages}
                phase={phase}
                elapsed={elapsed}
                pendingAudio={pendingAudio}
                beat={beat}
                onRecord={handleRecord}
                onDiscardAudio={handleDiscardTake}
                onSend={handleChatSend}
              />
            </div>
          </div>

          <PaywallModal
            isOpen={phase === 'paywall'}
            onContinueFree={() => setPhase('idle')}
            getToken={getToken}
          />

          <GuestLimitModal
            isOpen={phase === 'guest_limit'}
            onSignUp={() => {
              setPhase('idle')
              // Clerk's SignUpButton uses an imperative ref; falling back to navigating to its hosted page if needed.
              const btn = document.querySelector('[data-clerk-signup-trigger]')
              if (btn) btn.click()
            }}
            onClose={() => setPhase('idle')}
          />

          {/* Hidden Clerk SignUp trigger — programmatically clicked from GuestLimitModal */}
          {CLERK_ENABLED && (
            <div style={{ display: 'none' }}>
              <SignUpButton mode="modal">
                <button data-clerk-signup-trigger />
              </SignUpButton>
            </div>
          )}
      </div>
    </>
  )
}
