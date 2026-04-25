import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { SignInButton, SignedIn, SignedOut, UserButton, useAuth } from '@clerk/clerk-react'
import { SettingsWidget, LatestStatsWidget, YoutubeWidget, PaywallModal, OnboardingModal, SessionHistoryPanel, DeveloperFeedbackModal } from './components/AppPanels'
import './App.css'

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

function TunerWidget({ active, onToggle, disabled }) {
  const info = useTuner(active)
  const hasNote = info && !info.error && !!info.name
  const cents = hasNote ? (info.cents ?? 0) : 0
  const rotation = Math.max(-50, Math.min(50, cents)) * 0.9

  return (
    <div className="widget">
      <div className="widget-title">
        <span>Tuner</span>
        <button className="btn" onClick={onToggle} disabled={disabled}>
          {active ? 'Stop Tuner' : 'Start Tuner'}
        </button>
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

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const { getToken, isLoaded, isSignedIn } = useAuth()
  const navigate = useNavigate()
  const [bpm, setBpm] = useState(120)
  const [metroVolume, setMetroVolume] = useState(0.5)
  const [backingVolume, setBackingVolume] = useState(0.5)

  // Detect Stripe redirect params (?success=true / ?canceled=true)
  const stripeParams = new URLSearchParams(window.location.search)
  const [stripeNotice, setStripeNotice] = useState(
    stripeParams.get('success') === 'true' ? 'success' :
    stripeParams.get('canceled') === 'true' ? 'canceled' : null
  )
  useEffect(() => {
    if (stripeNotice) {
      // Clean the URL without reloading
      window.history.replaceState({}, '', window.location.pathname + window.location.hash.split('?')[0])
      const t = setTimeout(() => setStripeNotice(null), 6000)
      return () => clearTimeout(t)
    }
  }, [stripeNotice])
  
  const [phase, setPhase] = useState('idle') // idle | countdown | recording | review | analyzing | paywall
  const [countdown, setCountdown] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [sessionHistory, setSessionHistory] = useState([])
  const [profile, setProfile] = useState(null)
  const [pendingAudio, setPendingAudio] = useState(null)
  const [backingTrack, setBackingTrack] = useState(null)

  // New focused UI state
  const [userProblem, setUserProblem] = useState('')
  const [focusArea, setFocusArea] = useState('overall') // overall | Timing | Rhythm | Technique | Tone
  const [guitarStyle, setGuitarStyle] = useState('')
  const [showFeedbackModal, setShowFeedbackModal] = useState(false)
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [feedbackSessionId, setFeedbackSessionId] = useState(null)
  const [isSendingFeedback, setIsSendingFeedback] = useState(false)
  const [intentWarning, setIntentWarning] = useState('')
  
  const playerRef = useRef(null)
  
  const [tunerActive, setTunerActive] = useState(false)
  const [metroMuted, setMetroMuted] = useState(false)
  
  const beat = useMetronome(bpm, phase === 'recording' && !metroMuted, metroVolume)
  
  const inFlightRef = useRef(false)
  const recordingRef = useRef(null)
  const historyEndRef = useRef(null)

  useEffect(() => {
    if (playerRef.current) {
        playerRef.current.setVolume(backingVolume * 100);
    }
  }, [backingVolume])

  useEffect(() => {
    if (isLoaded && isSignedIn) {
       getToken().then(jwt => {
         axios.get('/api/profile', { headers: { Authorization: `Bearer ${jwt}` } })
           .then(res => {
              setProfile(res.data)
           })
           .catch(err => console.error(err))
       })
    }
  }, [isLoaded, isSignedIn, getToken])

  const handleOnboardingSubmit = async ({ skill, goal, language }) => {
     try {
       const jwt = await getToken()
       const { data } = await axios.post('/api/profile', { skill_level: skill, goal: goal, language: language }, {
         headers: { Authorization: `Bearer ${jwt}` }
       })
       setProfile(data)
     } catch (e) {
       alert("Error saving profile")
     }
  }

  // Auto-scroll to latest feedback
  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [sessionHistory])

  const handleRecord = async () => {
    if (phase === 'recording') {
      setPhase('analyzing')
      if (recordingRef.current) recordingRef.current.stop()
      return
    }

    if (!userProblem.trim()) {
      setIntentWarning('Please describe what you want help with first')
      return
    }
    setIntentWarning('')

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

    const pollAI = (sessionId, jwt) => {
      const startedAt = Date.now()
      const timer = setInterval(async () => {
          try {
          if (Date.now() - startedAt > AI_POLL_TIMEOUT_MS) {
            clearInterval(timer)
            setSessionHistory(prev => prev.map(s => s.backend_id === sessionId ? {
            ...s,
            ai_status: 'failed',
            ai_meta: {
              reason: 'AI analysis timed out before the server returned a result.',
              stage: 'timeout',
              uploaded_to_gemini: null,
            },
            } : s))
            return
          }
              const { data } = await axios.get(`/api/session/${sessionId}`, { headers: { Authorization: `Bearer ${jwt}` } });
              if (data.ai_status === 'completed' || data.ai_status === 'failed') {
                  clearInterval(timer);
            setSessionHistory(prev => prev.map(s => s.backend_id === sessionId ? {
            ...s,
            ai_status: data.ai_status,
            ai_advice: data.ai_advice,
            ai_meta: data.ai_meta,
            } : s));
              }
          } catch(e) {
              clearInterval(timer);
          }
      }, AI_POLL_INTERVAL_MS);
  }

  const handleAnalyzeTake = async () => {
    if (!pendingAudio) return
    setPhase('analyzing')
    inFlightRef.current = true
    
    const formData = new FormData()
    formData.append('file', pendingAudio.blob, 'recording.wav')
    formData.append('bpm', bpm)
    if (backingTrack) formData.append('backing_track_url', backingTrack.url)
      // Add new focused UI parameters
      formData.append('problem', userProblem)
      formData.append('focus', focusArea)
      formData.append('style', guitarStyle)
    
    try {
        const jwt = await getToken()
        const { data } = await axios.post('/api/analyze', formData, {
          headers: { Authorization: `Bearer ${jwt}` }
        })
        
        if (data.streak_days !== undefined) {
           setProfile(p => ({ ...p, streak_days: data.streak_days, current_focus: data.current_focus }))
        }
        
        const newSession = {
          id: Date.now(),
          backend_id: data.session_id,
          time: new Date().toLocaleTimeString(),
          ai_status: data.status === 'processing_ai' ? 'pending' : 'completed',
          ai_meta: null,
          ...data
        }

        setSessionHistory(prev => [...prev, newSession])
        
        if (data.status === 'processing_ai') {
            pollAI(data.session_id, jwt);
        }

        setPhase('idle')
        setPendingAudio(null)
    } catch(e) {
        if (e.response?.status === 403 && e.response?.data?.error === 'LIMIT_REACHED') {
          setPhase('paywall')
        } else {
          alert(e.response?.data?.error || e.message)
          setPhase('idle')
        }
    } finally {
        inFlightRef.current = false
    }
  }

  const handleDiscardTake = () => {
     if (pendingAudio?.url) URL.revokeObjectURL(pendingAudio.url)
     setPendingAudio(null)
     setPhase('idle')
  }

  const handleFeedbackSubmit = async () => {
    if (!feedbackMessage.trim()) return
    setIsSendingFeedback(true)
    try {
      const jwt = await getToken()
      await axios.post('/api/feedback', {
        message: feedbackMessage.trim(),
        session_id: feedbackSessionId,
      }, {
        headers: { Authorization: `Bearer ${jwt}` },
      })
      setFeedbackMessage('')
      setFeedbackSessionId(null)
      setShowFeedbackModal(false)
    } catch (e) {
      alert(e.response?.data?.error || e.message || 'Could not send feedback')
    } finally {
      setIsSendingFeedback(false)
    }
  }

  const latestResult = sessionHistory.length > 0 ? sessionHistory[sessionHistory.length - 1] : null
  const showOnboarding = profile && !profile.skill_level;

  return (
    <>
      <SignedOut>
        <div className="auth-overlay">
          <div className="auth-logo">ToneSense</div>
          <div className="auth-tagline">AI-Powered Guitar Coach</div>
          <div className="auth-card">
            <h2>Welcome back</h2>
            <p>Sign in to access your studio — AI analysis, precision tuner, and session tracking.</p>
            <SignInButton mode="modal">
              <button className="btn btn-accent" style={{width: '100%', padding: '11px', fontSize: '0.9rem', borderRadius: '8px'}}>Enter Studio</button>
            </SignInButton>
          </div>
        </div>
      </SignedOut>
      
      <SignedIn>
        <div className="app">
          <OnboardingModal isOpen={showOnboarding} onSubmit={handleOnboardingSubmit} />

          {/* 3-2-1 Countdown Overlay */}
          {phase === 'countdown' && (
             <div className="countdown-overlay">
                <div className="countdown-number">{countdown}</div>
                <div className="countdown-text">Get Ready...</div>
             </div>
          )}

          {/* Header */}
          <header className="app-header">
            <div className="app-title">ToneSense</div>
            <div className="header-right">
              <button className="header-profile-btn" onClick={() => setShowFeedbackModal(true)}>Send Feedback</button>
              <button className="header-profile-btn" onClick={() => navigate('/profile')}>⚙ Profile</button>
              <UserButton appearance={{ elements: { userButtonAvatarBox: { width: 28, height: 28 } } }} />
            </div>
          </header>

          {/* Stripe redirect notice */}
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
            {/* Left Panel: Controls */}
            <div className="controls-panel" style={{ pointerEvents: phase === 'countdown' ? 'none' : 'auto' }}>

              <div className="widget" style={{ paddingBottom: '18px' }}>
                <div className="widget-title">What do you want help with?</div>
                <textarea
                  className="input-field"
                  rows={4}
                  value={userProblem}
                  onChange={(e) => {
                    setUserProblem(e.target.value)
                    if (intentWarning) setIntentWarning('')
                  }}
                  placeholder={'e.g. My timing is inconsistent in fast alternate picking\n' +
                    'e.g. I want to improve metal riff accuracy'}
                  style={{ width: '100%', resize: 'vertical' }}
                />
                {intentWarning && (
                  <div style={{ marginTop: 8, color: 'var(--red)', fontSize: '0.85rem' }}>
                    {intentWarning}
                  </div>
                )}

                <div className="controls-grid" style={{ marginTop: 10 }}>
                  <div className="field">
                    <label>Focus</label>
                    <select value={focusArea} onChange={(e) => setFocusArea(e.target.value)}>
                      <option value="Timing">Timing</option>
                      <option value="Rhythm">Rhythm</option>
                      <option value="Technique">Technique</option>
                      <option value="Tone">Tone</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Style</label>
                    <input
                      className="input-field"
                      type="text"
                      placeholder="e.g. Metal, Blues, Jazz"
                      value={guitarStyle}
                      onChange={(e) => setGuitarStyle(e.target.value)}
                    />
                  </div>
                </div>
              </div>
              
              {profile && profile.skill_level && (
                 <div className="widget dashboard-habit-widget">
                    <div className="habit-header">
                       <span className="habit-streak">🔥 Streak: {profile.streak_days || 0} Days</span>
                       <span className="habit-focus-label">Current Focus</span>
                    </div>
                    <div className="habit-focus-text">
                       {profile.current_focus}
                    </div>
                 </div>
              )}

              <div className="widget" style={{paddingBottom: '24px'}}>
                <div className="transport-bar">
                  <button 
                    className={`record-btn-main ${phase}`} 
                    onClick={handleRecord}
                    disabled={phase === 'analyzing' || phase === 'countdown'}
                  >
                    <div className="rec-indicator" />
                    {phase === 'recording' ? 'Stop Recording' : phase === 'analyzing' ? 'Analyzing' : phase === 'countdown' ? 'Wait' : 'Start Recording'}
                  </button>
                  <div className={`timer-display ${phase === 'recording' ? 'recording' : ''}`}>
                     {(elapsed).toFixed(1)}s
                  </div>
                </div>

                {phase === 'review' && pendingAudio && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ color: 'var(--text-2)', fontSize: '0.85rem', marginBottom: 8 }}>Recording ready</div>
                    <audio src={pendingAudio.url} controls style={{ width: '100%', marginBottom: 10 }} />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn" onClick={handleDiscardTake}>Discard</button>
                      <button className="btn" style={{ background: 'var(--accent-dim)', color: '#000', border: 'none', fontWeight: 600 }} onClick={handleAnalyzeTake}>
                        Get Feedback
                      </button>
                    </div>
                  </div>
                )}

                <div className="metronome-controls">
                  <button className="btn" style={{padding: '4px 8px'}} onClick={() => setMetroMuted(m => !m)}>
                    {metroMuted ? 'Unmute Metro' : 'Mute Metro'}
                  </button>
                  <div className="metro-dots">
                    {[0, 1, 2, 3].map(i => (
                      <span key={i} className={`metro-dot ${beat === i ? (i === 0 ? 'accent' : 'active') : ''}`} />
                    ))}
                  </div>
                </div>
              </div>

              <TunerWidget active={tunerActive} onToggle={() => setTunerActive(a => !a)} disabled={phase === 'recording' || phase === 'countdown'} />
              <SettingsWidget 
                bpm={bpm} setBpm={setBpm} 
                metroVolume={metroVolume} setMetroVolume={setMetroVolume} 
                backingVolume={backingVolume} setBackingVolume={setBackingVolume}
                hasBackingTrack={!!backingTrack}
              />
              <YoutubeWidget backingTrack={backingTrack} setBackingTrack={setBackingTrack} disabled={phase !== 'idle'} playerRef={playerRef} />
              <LatestStatsWidget result={latestResult} />
            </div>

            <SessionHistoryPanel sessionHistory={sessionHistory} historyEndRef={historyEndRef} />
          </div>
          
          <PaywallModal
            isOpen={phase === 'paywall'}
            onContinueFree={() => setPhase('idle')}
            getToken={getToken}
          />

          <DeveloperFeedbackModal
            isOpen={showFeedbackModal}
            message={feedbackMessage}
            setMessage={setFeedbackMessage}
            onClose={() => setShowFeedbackModal(false)}
            onSend={handleFeedbackSubmit}
            sending={isSendingFeedback}
          />

          <div style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: '0.78rem', padding: '8px 0 14px' }}>
            This is an experimental AI tool. Feedback may not always be accurate.
          </div>
        </div>
      </SignedIn>
    </>
  )
}
