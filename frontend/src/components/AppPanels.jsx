import { useState } from 'react'
import axios from 'axios'
import YouTube from 'react-youtube'
import PerformanceChart from '../PerformanceChart'

function metricColor(key, value) {
  if (key === 'accuracy_pct') return value >= 85 ? 'metric-good' : value >= 60 ? 'metric-warn' : 'metric-bad'
  if (key === 'on_time_ratio') return value >= 0.8 ? 'metric-good' : value >= 0.5 ? 'metric-warn' : 'metric-bad'
  if (key === 'timing_consistency') return value >= 70 ? 'metric-good' : value >= 40 ? 'metric-warn' : 'metric-bad'
  if (key === 'amplitude_db') return value >= -40 ? 'metric-good' : value >= -55 ? 'metric-warn' : 'metric-bad'
  return 'metric-nil'
}

export function SettingsWidget({ bpm, setBpm, metroVolume, setMetroVolume, backingVolume, setBackingVolume, hasBackingTrack }) {
  return (
    <div className="widget">
      <div className="widget-title">Session Controls</div>
      <div className="controls-grid">
        <div className="field">
          <label>Tempo (BPM)</label>
          <input type="number" min="40" max="240" value={bpm} onChange={e => setBpm(e.target.value)} />
        </div>
        <div className="field">
          <label>Metronome Vol</label>
          <input type="range" min="0" max="1" step="0.05" value={metroVolume} onChange={e => setMetroVolume(parseFloat(e.target.value))} />
        </div>
        {hasBackingTrack && (
          <div className="field">
            <label>Backing Vol</label>
            <input type="range" min="0" max="1" step="0.05" value={backingVolume} onChange={e => setBackingVolume(parseFloat(e.target.value))} />
          </div>
        )}
      </div>
    </div>
  )
}

export function LatestStatsWidget({ result }) {
  if (!result) return null

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

export function YoutubeWidget({ backingTrack, setBackingTrack, disabled, playerRef }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  const extractVideoId = (u) => {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/
    const match = u.match(regExp)
    return (match && match[2].length === 11) ? match[2] : null
  }

  const handleLoad = () => {
    const id = extractVideoId(url)
    if (id) {
      setBackingTrack({ url, videoId: id })
      setError('')
    } else {
      setError('Invalid YouTube URL')
    }
  }

  const onReady = (event) => {
    playerRef.current = event.target
  }

  return (
    <div className="widget" style={{ paddingBottom: '16px' }}>
      <div className="widget-title">Backing Track</div>
      {backingTrack ? (
        <div className="yt-embed-container">
          <YouTube
            videoId={backingTrack.videoId}
            opts={{ height: '180', width: '100%', playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 } }}
            onReady={onReady}
          />
          <button className="btn" style={{ marginTop: 8, width: '100%' }} onClick={() => { setBackingTrack(null); playerRef.current = null }} disabled={disabled}>Change Track</button>
        </div>
      ) : (
        <div className="controls-grid" style={{ gridTemplateColumns: '1fr auto', gap: 8 }}>
          <input className="input-field" placeholder="Paste YouTube URL..." value={url} onChange={e => setUrl(e.target.value)} disabled={disabled} />
          <button className="btn" onClick={handleLoad} disabled={disabled || !url}>Load</button>
        </div>
      )}
      {error && <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginTop: '8px' }}>{error}</div>}
    </div>
  )
}

export function PaywallModal({ isOpen, onContinueFree, getToken }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  if (!isOpen) return null

  const handleUpgrade = async () => {
    setLoading(true)
    setError(null)
    try {
      const jwt = await getToken()
      const { data } = await axios.post(
        '/api/create-checkout-session',
        {},
        { headers: { Authorization: `Bearer ${jwt}` } }
      )
      window.location.href = data.url
    } catch {
      setError('Unable to start checkout. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2>Analysis Limit Reached</h2>
        <p>
          You've used all your free analyses for today. Upgrade to PRO for
          unlimited AI coaching sessions, priority processing, and advanced
          performance insights.
        </p>
        {error && (
          <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginBottom: '12px' }}>
            {error}
          </div>
        )}
        <button
          className="btn"
          style={{
            borderColor: 'var(--yellow)',
            color: 'var(--yellow)',
            width: '100%',
            marginBottom: '12px',
            padding: '12px',
            fontSize: '1rem',
            opacity: loading ? 0.6 : 1,
          }}
          onClick={handleUpgrade}
          disabled={loading}
        >
          {loading ? (
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <span style={{
                display: 'inline-block',
                width: 14,
                height: 14,
                border: '2px solid var(--yellow)',
                borderTopColor: 'transparent',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }} />
              Redirecting to Checkout...
            </span>
          ) : (
            'Upgrade to PRO'
          )}
        </button>
        <button
          className="btn"
          style={{ width: '100%', opacity: 0.7 }}
          onClick={onContinueFree}
          disabled={loading}
        >
          Continue Free
        </button>
      </div>
    </div>
  )
}

export function OnboardingModal({ isOpen, onSubmit }) {
  const [skill, setSkill] = useState('beginner')
  const [goal, setGoal] = useState('timing')
  const [language, setLanguage] = useState('English')

  if (!isOpen) return null

  return (
    <div className="modal-overlay">
      <div className="modal-content onboarding-content">
        <h2>Welcome to ToneSense</h2>
        <p>Let's personalize your learning plan to build a daily habit.</p>

        <div className="field">
          <label>What is your skill level?</label>
          <select value={skill} onChange={e => setSkill(e.target.value)}>
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
          </select>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>What is your primary goal?</label>
          <select value={goal} onChange={e => setGoal(e.target.value)}>
            <option value="timing">Mastering Timing & Rhythm</option>
            <option value="soloing">Soloing & Phrasing</option>
            <option value="technique">Clean Technique</option>
            <option value="speed">Building Speed</option>
          </select>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>Preferred AI Language</label>
          <select value={language} onChange={e => setLanguage(e.target.value)}>
            <option value="English">English</option>
            <option value="Magyar (Hungarian)">Magyar (Hungarian)</option>
            <option value="Espanol (Spanish)">Espanol (Spanish)</option>
          </select>
        </div>

        <button className="btn" style={{ marginTop: '24px', width: '100%', padding: '12px', fontSize: '1rem' }} onClick={() => onSubmit({ skill, goal, language })}>
          Start My Journey
        </button>
      </div>
    </div>
  )
}

export function DeveloperFeedbackModal({ isOpen, message, setMessage, onClose, onSend, sending }) {
  if (!isOpen) return null

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: 520 }}>
        <h2 style={{ marginTop: 0 }}>Send Feedback</h2>
        <p style={{ color: 'var(--text-2)', fontSize: '0.9rem' }}>
          This message is sent directly to the developer.
        </p>
        <textarea
          className="input-field"
          rows={6}
          placeholder="Describe bug, UX issue, or suggestion..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={{ width: '100%', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button className="btn" onClick={onClose} disabled={sending}>Cancel</button>
          <button className="btn" onClick={onSend} disabled={sending || !message.trim()} style={{ background: 'var(--accent-dim)', color: '#000', border: 'none', fontWeight: 600 }}>
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function SessionHistoryPanel({ sessionHistory, historyEndRef }) {
  return (
    <div className="session-panel">
      <div className="widget" style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-panel-hi)' }}>
        <div className="widget-title" style={{ margin: 0 }}>Session History</div>
      </div>
      <div className="session-history-container">
        <PerformanceChart sessions={sessionHistory} />

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

            {item.ai_status === 'pending' && (
              <div className="ai-feedback-box" style={{ opacity: 0.7, textAlign: 'center' }}>
                <div style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid var(--accent)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: 8, marginTop: 8 }}></div>
                <div style={{ fontSize: '0.9rem', color: 'var(--text-2)' }}>ToneSense AI is analyzing your performance...</div>
              </div>
            )}
            {item.ai_status === 'failed' && (
              <div className="ai-feedback-box" style={{ color: 'var(--red)', fontSize: '0.9rem' }}>
                AI analysis failed.
                {item.ai_meta?.reason ? ` ${item.ai_meta.reason}` : ' Please try again.'}
              </div>
            )}
            {item.ai_status !== 'pending' && item.ai_status !== 'failed' && item.ai_advice && typeof item.ai_advice === 'object' && (
              <div className="ai-feedback-box">
                <div className="ai-feedback-header">Performance Review</div>
                {item.ai_meta?.used_fallback && (
                  <div style={{ marginBottom: 10, padding: '8px 10px', background: 'rgba(180, 140, 80, 0.12)', border: '1px solid rgba(180, 140, 80, 0.28)', borderRadius: 6, color: 'var(--text-2)', fontSize: '0.82rem' }}>
                    {item.ai_meta.uploaded_to_gemini === true
                      ? 'The WAV reached Gemini, but the AI response fell back to local guidance.'
                      : 'The WAV did not complete the Gemini pipeline, so local fallback guidance was shown instead.'}
                    {item.ai_meta.stage ? ` Stage: ${item.ai_meta.stage}.` : ''}
                    {item.ai_meta.reason ? ` Reason: ${item.ai_meta.reason}` : ''}
                  </div>
                )}
                {item.ai_advice.diagnosis ? (
                  <>
                    <div style={{ marginBottom: 10 }}>
                      <strong>Diagnosis</strong>
                      <div className="ai-summary" style={{ marginTop: 4 }}>{item.ai_advice.diagnosis}</div>
                    </div>

                    {!!item.ai_advice.specific_issues?.length && (
                      <div style={{ marginBottom: 10 }}>
                        <strong>Issues</strong>
                        <ul style={{ marginTop: 6, marginBottom: 0, paddingLeft: 18 }}>
                          {item.ai_advice.specific_issues.map((issue, idx) => (
                            <li key={`issue-${item.id}-${idx}`} style={{ marginBottom: 4 }}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {!!item.ai_advice.actionable_fixes?.length && (
                      <div style={{ marginBottom: 10 }}>
                        <strong>Fixes</strong>
                        <ul style={{ marginTop: 6, marginBottom: 0, paddingLeft: 18 }}>
                          {item.ai_advice.actionable_fixes.map((fix, idx) => (
                            <li key={`fix-${item.id}-${idx}`} style={{ marginBottom: 4 }}>{fix}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {item.ai_advice.focused_exercise && item.ai_advice.focused_exercise !== 'null' && (
                      <div>
                        <strong>Exercise</strong>
                        <div style={{ marginTop: 4, color: 'var(--text-1)' }}>{item.ai_advice.focused_exercise}</div>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="ai-summary">{item.ai_advice.summary}</div>

                    <div className="ai-details-grid tonesense-badges" style={{ display: 'flex', gap: '8px', flexDirection: 'row' }}>
                      <div className="tonesense-badge" style={{ flex: 1, background: 'var(--bg-deep)', padding: '8px', borderRadius: '4px', border: '1px solid var(--border)', fontSize: '0.8rem' }}>
                        <strong style={{ color: 'var(--blue)' }}>Key/Scale:</strong><br />{item.ai_advice.detected_scale || 'N/A'}
                      </div>
                      <div className="tonesense-badge" style={{ flex: 1, background: 'var(--bg-deep)', padding: '8px', borderRadius: '4px', border: '1px solid var(--border)', fontSize: '0.8rem' }}>
                        <strong style={{ color: 'var(--yellow)' }}>Rhythm:</strong><br />{item.ai_advice.detected_rhythm || 'N/A'}
                      </div>
                    </div>

                    <div className="ai-details-grid">
                      <div className="ai-col fix">
                        <strong>Musical Insight:</strong>
                        <div style={{ marginTop: 4, lineHeight: 1.5, color: 'var(--text-1)' }}>{item.ai_advice.musical_advice || item.ai_advice.problem}</div>
                      </div>
                      <div className="ai-col issue" style={{ marginTop: 8 }}>
                        <strong>Technical Focus:</strong>
                        <div style={{ marginTop: 4, color: 'var(--red)' }}>{item.ai_advice.technical_focus || item.ai_advice.cause}</div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

          </div>
        ))}
        <div ref={historyEndRef} />
      </div>
    </div>
  )
}

// ── ChatPanel ─────────────────────────────────────────────────────────────────
export function ChatPanel({ sessionId, getToken, initialMessages = [] }) {
  const [messages, setMessages] = useState(initialMessages)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const API = import.meta.env.VITE_API_URL || ''

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: text }])

    try {
      const token = await getToken()
      const res = await axios.post(
        `${API}/api/session/${sessionId}/chat`,
        { message: text },
        { headers: { Authorization: `Bearer ${token}` } }
      )
      setMessages(prev => [...prev, { role: 'assistant', content: res.data.response }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '⚠ Error sending message. Please try again.' }])
    } finally {
      setSending(false)
    }
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  return (
    <div className="widget" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="widget-title">💬 Continue the Lesson</div>
      {messages.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '12px 0', textAlign: 'center' }}>
          Ask a follow-up question or request a deeper explanation…
        </div>
      )}
      <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '8px 0' }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 8 }}>
            <div style={{
              maxWidth: '82%',
              padding: '10px 14px',
              borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
              background: m.role === 'user' ? 'var(--accent)' : 'var(--bg-deep)',
              color: m.role === 'user' ? '#fff' : 'var(--text-1)',
              border: m.role === 'assistant' ? '1px solid var(--border)' : 'none',
              fontSize: '0.9rem',
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
            }}>
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
            <div style={{ padding: '10px 14px', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '16px 16px 16px 4px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              ✦ Thinking…
            </div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask a question or describe what you tried… (Enter to send, Shift+Enter for newline)"
          rows={2}
          style={{ flex: 1, resize: 'none', fontSize: '0.9rem' }}
          className="input-field"
          disabled={sending}
        />
        <button
          onClick={sendMessage}
          disabled={sending || !input.trim()}
          style={{ alignSelf: 'flex-end', padding: '8px 16px' }}
          className="btn-primary"
        >
          Send
        </button>
      </div>
    </div>
  )
}
