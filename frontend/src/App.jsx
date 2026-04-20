import { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'
import { SignInButton, SignedIn, SignedOut, UserButton, useAuth } from '@clerk/clerk-react'
import './App.css'

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

function SettingsWidget({ bpm, setBpm, metroVolume, setMetroVolume }) {
  return (
    <div className="widget">
      <div className="widget-title">Engine Parameters</div>
      <div className="controls-grid">
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
  )
}

function metricColor(key, value) {
  if (key === 'accuracy_pct') return value >= 85 ? 'metric-good' : value >= 60 ? 'metric-warn' : 'metric-bad'
  if (key === 'on_time_ratio') return value >= 0.8 ? 'metric-good' : value >= 0.5 ? 'metric-warn' : 'metric-bad'
  if (key === 'timing_consistency') return value >= 70 ? 'metric-good' : value >= 40 ? 'metric-warn' : 'metric-bad'
  if (key === 'amplitude_db') return value >= -40 ? 'metric-good' : value >= -55 ? 'metric-warn' : 'metric-bad'
  return 'metric-nil'
}

function LatestStatsWidget({ result }) {
  if (!result) return null;
  const { notes = [], errors = [] } = result;

  return (
    <div className="widget">
      <div className="widget-title">Latest Analysis Data</div>
      <div className="metrics-grid-dense">
        <div className="metric-box">
          <div className={`metric-box-val ${metricColor('accuracy_pct', result.accuracy_pct)}`}>
            {result.accuracy_pct?.toFixed(0)}%
          </div>
          <div className="metric-box-lbl">Pitch Acc</div>
        </div>
        <div className="metric-box">
          <div className={`metric-box-val ${metricColor('on_time_ratio', result.on_time_ratio)}`}>
            {((result.on_time_ratio || 0) * 100).toFixed(0)}%
          </div>
          <div className="metric-box-lbl">On-Time</div>
        </div>
        <div className="metric-box">
          <div className="metric-box-val">{result.timing_error_ms > 0 ? '+' : ''}{result.timing_error_ms?.toFixed(0)}ms</div>
          <div className="metric-box-lbl">Timing Err</div>
        </div>
        <div className="metric-box">
          <div className={`metric-box-val ${metricColor('amplitude_db', result.amplitude_db)}`}>
            {result.amplitude_db?.toFixed(0)}dB
          </div>
          <div className="metric-box-lbl">Level</div>
        </div>
      </div>
    </div>
  )
}

function OnboardingModal({ isOpen, onSubmit }) {
  const [skill, setSkill] = useState('beginner')
  const [goal, setGoal] = useState('timing')
  const [language, setLanguage] = useState('English')

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content onboarding-content">
        <h2>Welcome to Guitar Coach Pro</h2>
        <p>Let's personalize your learning plan to build a daily habit.</p>
        
        <div className="field">
           <label>What is your skill level?</label>
           <select value={skill} onChange={e => setSkill(e.target.value)}>
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
           </select>
        </div>
        
        <div className="field" style={{marginTop: 12}}>
           <label>What is your primary goal?</label>
           <select value={goal} onChange={e => setGoal(e.target.value)}>
              <option value="timing">Mastering Timing & Rhythm</option>
              <option value="soloing">Soloing & Phrasing</option>
              <option value="technique">Clean Technique</option>
              <option value="speed">Building Speed</option>
           </select>
        </div>

        <div className="field" style={{marginTop: 12}}>
           <label>Preferred AI Language</label>
           <select value={language} onChange={e => setLanguage(e.target.value)}>
              <option value="English">English</option>
              <option value="Magyar (Hungarian)">Magyar (Hungarian)</option>
              <option value="Español (Spanish)">Español (Spanish)</option>
           </select>
        </div>

        <button className="btn" style={{marginTop: '24px', width: '100%', padding: '12px', fontSize: '1rem'}} onClick={() => onSubmit({skill, goal, language})}>
          Start My Journey
        </button>
      </div>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const { getToken, isLoaded, isSignedIn } = useAuth()
  const [bpm, setBpm] = useState(120)
  const [metroVolume, setMetroVolume] = useState(0.5)
  
  const [phase, setPhase] = useState('idle') // idle | countdown | recording | review | analyzing | paywall
  const [countdown, setCountdown] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [sessionHistory, setSessionHistory] = useState([])
  const [profile, setProfile] = useState(null)
  const [pendingAudio, setPendingAudio] = useState(null)
  
  const [tunerActive, setTunerActive] = useState(false)
  const [metroMuted, setMetroMuted] = useState(false)
  
  const beat = useMetronome(bpm, phase === 'recording' && !metroMuted, metroVolume)
  
  const inFlightRef = useRef(false)
  const recordingRef = useRef(null)
  const historyEndRef = useRef(null)

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
      
      recordingRef.current = {
        active: true,
        stop: async () => {
            if (!recordingRef.current.active) return
            recordingRef.current.active = false
            
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

  const handleAnalyzeTake = async () => {
    if (!pendingAudio) return
    setPhase('analyzing')
    inFlightRef.current = true
    
    const formData = new FormData()
    formData.append('file', pendingAudio.blob, 'recording.wav')
    formData.append('bpm', bpm)
    
    try {
        const jwt = await getToken()
        const { data } = await axios.post('/api/analyze', formData, {
          headers: { Authorization: `Bearer ${jwt}` }
        })
        
        if (data.streak_days !== undefined) {
           setProfile(p => ({ ...p, streak_days: data.streak_days, current_focus: data.current_focus }))
        }
        setSessionHistory(prev => [...prev, {
          id: Date.now(),
          time: new Date().toLocaleTimeString(),
          ...data
        }])
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

  const latestResult = sessionHistory.length > 0 ? sessionHistory[sessionHistory.length - 1] : null
  const showOnboarding = profile && !profile.skill_level;

  return (
    <>
      <SignedOut>
        <div className="auth-overlay">
          <h1>Guitar Coach Pro</h1>
          <p>Login to access the AI analysis engine, precision metronome, and tuner.</p>
          <SignInButton mode="modal">
            <button className="btn" style={{padding: '12px 32px', fontSize: '1rem'}}>Access Platform</button>
          </SignInButton>
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

          {/* Review Take Overlay */}
          {phase === 'review' && pendingAudio && (
             <div className="countdown-overlay">
                <div style={{ background: 'var(--bg-panel)', padding: '24px', borderRadius: '8px', textAlign: 'center' }}>
                   <h2 style={{ marginBottom: '16px', color: 'var(--text-1)', fontWeight: '500' }}>Review Recording</h2>
                   <audio src={pendingAudio.url} controls style={{ marginBottom: '24px', display: 'block', outline: 'none' }} />
                   <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                      <button className="btn" style={{ borderColor: 'var(--text-3)', color: 'var(--text-2)' }} onClick={handleDiscardTake}>Discard</button>
                      <button className="btn" style={{ background: 'var(--accent-dim)', color: '#000', fontWeight: 600, border: 'none' }} onClick={handleAnalyzeTake}>Upload & Analyze</button>
                   </div>
                </div>
             </div>
          )}

          {/* Header */}
          <header className="app-header">
            <div className="app-title">Guitar Coach Pro</div>
            <UserButton appearance={{ elements: { userButtonAvatarBox: { width: 28, height: 28 } } }} />
          </header>

          <div className="workspace">
            {/* Left Panel: Controls */}
            <div className="controls-panel" style={{ pointerEvents: phase === 'countdown' ? 'none' : 'auto' }}>
              
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
                    {phase === 'recording' ? 'STOP' : phase === 'analyzing' ? 'ANALYZING' : phase === 'countdown' ? 'WAIT' : 'RECORD'}
                  </button>
                  <div className={`timer-display ${phase === 'recording' ? 'recording' : ''}`}>
                     {(elapsed).toFixed(1)}s
                  </div>
                </div>

                <div className="metronome-controls">
                  <button className="btn" style={{padding: '4px 8px'}} onClick={() => setMetroMuted(m => !m)} disabled={phase !== 'recording'}>
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
              <SettingsWidget bpm={bpm} setBpm={setBpm} metroVolume={metroVolume} setMetroVolume={setMetroVolume} />
              <LatestStatsWidget result={latestResult} />
            </div>

            {/* Right Panel: Session History */}
            <div className="session-panel">
               <div className="widget" style={{borderBottom: '1px solid var(--border)', background: 'var(--bg-panel-hi)'}}>
                 <div className="widget-title" style={{margin: 0}}>Guided Practice History</div>
               </div>
               <div className="session-history-container">
                  {sessionHistory.length === 0 && (
                    <div className="empty-state">
                      Record a take to track your progress and receive AI feedback.
                    </div>
                  )}
                  {sessionHistory.map(item => (
                    <div key={item.id} className="history-item">
                       <div className="history-header">
                         <span className="history-time">{item.time}</span>
                         <div className="history-result-stats">
                           <span className="stat-pill">ACC: {item.accuracy_pct?.toFixed(0)}%</span>
                           <span className="stat-pill">BPM: {item.bpm || 120}</span>
                         </div>
                       </div>
                       
                       {item.ai_advice && typeof item.ai_advice === 'object' && (
                          <div className="ai-feedback-box">
                             <div className="ai-feedback-header">Progress Check</div>
                             <div className="ai-summary">{item.ai_advice.summary}</div>
                             
                             <div className="ai-details-grid">
                                <div className="ai-col issue">
                                   <strong>Problem:</strong> {item.ai_advice.problem}
                                </div>
                                <div className="ai-col fix">
                                   <strong>To Fix:</strong>
                                   <ul>
                                     {Array.isArray(item.ai_advice.fix) ? item.ai_advice.fix.map((f, i) => <li key={i}>{f}</li>) : <li>{item.ai_advice.fix}</li>}
                                   </ul>
                                </div>
                             </div>
                             
                             <div className="ai-encouragement">{item.ai_advice.encouragement}</div>
                          </div>
                       )}

                    </div>
                  ))}
                  <div ref={historyEndRef} />
               </div>
            </div>
          </div>
          
          {phase === 'paywall' && (
            <div className="modal-overlay">
              <div className="modal-content">
                <h2>Analysis Limit Reached</h2>
                <p>You have reached the free limit of 5 analyses per day. Upgrade to a Pro account for unlimited coaching.</p>
                <button className="btn" style={{borderColor: 'var(--yellow)', color: 'var(--yellow)', width: '100%', marginBottom: '12px'}} onClick={async () => {
                    try {
                      const jwt = await getToken();
                      const { data } = await axios.post('/api/create-checkout-session', {}, { headers: { Authorization: `Bearer ${jwt}` } });
                      window.location.href = data.url;
                    } catch(err) {
                      alert("Billing system unavailable.");
                      setPhase('idle');
                    }
                }}>Upgrade to Pro</button>
                <button className="btn" style={{width: '100%', opacity: 0.7}} onClick={() => setPhase('idle')}>Dismiss</button>
              </div>
            </div>
          )}

        </div>
      </SignedIn>
    </>
  )
}
