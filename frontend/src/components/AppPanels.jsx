import { useState, useRef, useEffect } from 'react'
import ReactDOM from 'react-dom'
import axios from 'axios'
import YouTube from 'react-youtube'
import PerformanceChart from '../PerformanceChart'

export function SectionTooltip({ text }) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const iconRef = useRef(null)

  const show = () => {
    if (!iconRef.current) return
    const r = iconRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + 6, left: r.left })
    setVisible(true)
  }
  const hide = () => setVisible(false)

  return (
    <span className="section-tooltip" onMouseEnter={show} onMouseLeave={hide}>
      <span ref={iconRef} className="section-tooltip-icon">i</span>
      {visible && ReactDOM.createPortal(
        <span className="section-tooltip-text section-tooltip-text--portal" style={{ top: pos.top, left: pos.left }}>
          {text}
        </span>,
        document.body
      )}
    </span>
  )
}

function metricColor(key, value) {
  if (key === 'accuracy_pct') return value >= 85 ? 'metric-good' : value >= 60 ? 'metric-warn' : 'metric-bad'
  if (key === 'on_time_ratio') return value >= 0.8 ? 'metric-good' : value >= 0.5 ? 'metric-warn' : 'metric-bad'
  if (key === 'timing_consistency') return value >= 70 ? 'metric-good' : value >= 40 ? 'metric-warn' : 'metric-bad'
  if (key === 'amplitude_db') return value >= -40 ? 'metric-good' : value >= -55 ? 'metric-warn' : 'metric-bad'
  return 'metric-nil'
}

export function LatestStatsWidget({ result }) {
  if (!result) return null

  return (
    <div className="widget">
      <div className="widget-title">
        <span>Latest Analysis Data</span>
      </div>
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

export function YoutubeWidget({ backingTrack, setBackingTrack, disabled, playerRef, backingVolume, setBackingVolume }) {
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
      <div className="widget-title">
        <span>Backing Track</span>
        <SectionTooltip text="Paste a YouTube URL to play along with a song or lesson video. The backing track won't be captured in your recording." />
      </div>
      {backingTrack ? (
        <div className="yt-embed-container">
          <YouTube
            videoId={backingTrack.videoId}
            opts={{ height: '180', width: '100%', playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 } }}
            onReady={onReady}
          />
          <div className="field" style={{ marginTop: 10 }}>
            <label>Backing Vol</label>
            <input type="range" min="0" max="1" step="0.05" value={backingVolume} onChange={e => setBackingVolume(parseFloat(e.target.value))} />
          </div>
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

export function GuestLimitModal({ isOpen, onSignUp, onClose }) {
  if (!isOpen) return null

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2>You've used your 3 free analyses today</h2>
        <p>
          Sign up for a free account to get <strong>5 analyses per day</strong> and save your
          progress, streaks, and history. Upgrade to PRO for unlimited coaching anytime.
        </p>
        <button
          className="btn btn-accent"
          style={{ width: '100%', marginBottom: '12px', padding: '12px', fontSize: '1rem' }}
          onClick={onSignUp}
        >
          Sign up — Free
        </button>
        <button
          className="btn"
          style={{ width: '100%', opacity: 0.7 }}
          onClick={onClose}
        >
          Continue chatting (text only)
        </button>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 12, textAlign: 'center' }}>
          Text chat with the AI is always unlimited. Only audio analyses are capped.
        </p>
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

// ── AIChatBubble (internal helper) ───────────────────────────────────────────
function AIChatBubble({ message }) {
  if (message.status === 'analyzing') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <div style={{
          maxWidth: '80%',
          padding: '12px 16px',
          background: 'var(--bg-deep)',
          border: '1px solid var(--border)',
          borderRadius: '16px 16px 16px 4px',
          color: 'var(--text-muted)',
          fontSize: '0.88rem',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{
            display: 'inline-block',
            width: 14,
            height: 14,
            border: '2px solid var(--accent)',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            flexShrink: 0,
          }} />
          Analyzing your recording…
        </div>
      </div>
    )
  }

  const d = message.ai_data

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div style={{
        maxWidth: '80%',
        padding: '14px 18px',
        background: 'var(--bg-deep)',
        border: message.status === 'error' ? '1px solid rgba(220,50,50,0.4)' : '1px solid var(--border)',
        borderRadius: '16px 16px 16px 4px',
        fontSize: '0.88rem',
        lineHeight: 1.65,
        color: message.status === 'error' ? 'var(--red)' : 'var(--text-1)',
      }}>
        {d ? (
          <>
            {d.diagnosis && (
              <p style={{ marginTop: 0, marginBottom: 12 }}>{d.diagnosis}</p>
            )}
            {d.specific_issues?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 600, color: 'var(--red)', fontSize: '0.74rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Issues</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {d.specific_issues.map((issue, i) => (
                    <li key={i} style={{ marginBottom: 3 }}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
            {d.actionable_fixes?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 600, color: 'var(--green)', fontSize: '0.74rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Fixes</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {d.actionable_fixes.map((fix, i) => (
                    <li key={i} style={{ marginBottom: 3 }}>{fix}</li>
                  ))}
                </ul>
              </div>
            )}
            {d.focused_exercise && d.focused_exercise !== 'null' && (
              <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(255,178,50,0.07)', border: '1px solid rgba(255,178,50,0.2)', borderRadius: 8 }}>
                <div style={{ fontWeight: 600, color: 'var(--yellow)', fontSize: '0.74rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Exercise</div>
                <div>{d.focused_exercise}</div>
              </div>
            )}
            {d.follow_up_question && (
              <div style={{ marginTop: 12, fontStyle: 'italic', color: 'var(--text-2)', fontSize: '0.86rem' }}>
                {d.follow_up_question}
              </div>
            )}
          </>
        ) : (
          <div style={{ whiteSpace: 'pre-wrap' }}>{message.text}</div>
        )}
      </div>
    </div>
  )
}

// ── ConversationalChat ────────────────────────────────────────────────────────
export function ConversationalChat({ messages, phase, elapsed, pendingAudio, onRecord, onDiscardAudio, onSend, panelEverOpened, onExpandPanel }) {
  const [text, setText] = useState('')
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const isRecording = phase === 'recording'
  const isBusy = phase === 'analyzing' || phase === 'countdown'
  const hasAudio = !!pendingAudio
  const canSend = (text.trim() || hasAudio) && !isRecording && !isBusy

  const handleSend = () => {
    if (!canSend) return
    onSend(text.trim(), pendingAudio || null)
    setText('')
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)' }}>
      {/* Chat header */}
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-1)' }}>ToneSense AI</span>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>guitar coach</span>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '16px 20px',
      }}>
        {messages.length === 0 && (
          <div style={{
            margin: 'auto',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.9rem',
            lineHeight: 1.7,
            maxWidth: 340,
            paddingTop: 40,
          }}>
            <div>Record your playing or ask a question to get started.</div>
            <div style={{ fontSize: '0.8rem', marginTop: 8, color: 'var(--text-3)' }}>
              Hit the mic button below, or just type something.
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          m.role === 'user' ? (
            <div key={m.id || i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              {m.text && (
                <div style={{
                  maxWidth: '75%',
                  padding: '10px 16px',
                  background: 'var(--accent)',
                  color: '#1a0f00',
                  borderRadius: '16px 16px 4px 16px',
                  fontSize: '0.88rem',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  fontWeight: 500,
                }}>
                  {m.text}
                </div>
              )}
              {m.audio_url && (
                <audio src={m.audio_url} controls style={{ maxWidth: '100%', height: 36, opacity: 0.85 }} />
              )}
            </div>
          ) : (
            <AIChatBubble key={m.id || i} message={m} />
          )
        ))}

        {/* Refine-feedback prompt — shown once after first completed AI response */}
        {onExpandPanel &&
         !panelEverOpened &&
         messages.length > 0 &&
         messages[messages.length - 1]?.role === 'assistant' &&
         messages[messages.length - 1]?.status === 'done' && (
          <div className="refine-prompt">
            <span>Want more precise feedback?</span>
            <button onClick={onExpandPanel}>Add tempo / key / style →</button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', flexShrink: 0 }}>
        {/* Audio attachment pill */}
        {hasAudio && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            padding: '6px 12px',
            background: 'var(--bg-deep)',
            borderRadius: 8,
            border: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-2)', flex: 1 }}>
              🎙 Recording ready · {elapsed.toFixed(1)}s
            </span>
            <audio src={pendingAudio.url} controls style={{ height: 28 }} />
            <button
              onClick={onDiscardAudio}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.1rem', padding: '0 4px', lineHeight: 1 }}
              title="Discard recording"
            >×</button>
          </div>
        )}

        {/* Recording indicator */}
        {isRecording && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: '0.82rem', color: 'var(--red)' }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--red)', animation: 'pulse 1s ease-in-out infinite' }} />
            Recording · {elapsed.toFixed(1)}s — click stop when done
          </div>
        )}

        {/* Input row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKey}
            placeholder={
              isRecording ? 'Recording in progress…' :
                hasAudio ? 'Add a note (optional) then Send…' :
                  'Ask a question or record your playing…'
            }
            rows={2}
            disabled={isRecording || isBusy}
            className="input-field"
            style={{ flex: 1, resize: 'none', fontSize: '0.88rem' }}
          />

          {/* Mic / Stop button */}
          <button
            onClick={onRecord}
            disabled={isBusy || hasAudio}
            title={isRecording ? 'Stop recording' : 'Start recording'}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: `1px solid ${isRecording ? 'var(--red)' : 'var(--border)'}`,
              background: isRecording ? 'rgba(220,50,50,0.12)' : 'var(--bg-deep)',
              color: isRecording ? 'var(--red)' : 'var(--text-2)',
              cursor: (isBusy || hasAudio) ? 'not-allowed' : 'pointer',
              fontSize: '1.1rem',
              lineHeight: 1,
              flexShrink: 0,
              alignSelf: 'flex-end',
              opacity: (isBusy || hasAudio) ? 0.4 : 1,
            }}
          >
            {isRecording ? '⏹' : '🎙'}
          </button>

          {/* Send button */}
          <button
            className="btn-primary"
            onClick={handleSend}
            disabled={!canSend}
            style={{ padding: '8px 18px', alignSelf: 'flex-end', flexShrink: 0 }}
          >
            {isBusy ? 'Wait…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── ChatPanel (legacy, kept for reference) ────────────────────────────────────
export function ChatPanel({ sessionId, getToken, context = {}, initialMessages = [] }) {
  const [messages, setMessages] = useState(initialMessages)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef(null)

  const API = import.meta.env.VITE_API_URL || ''

  // Auto-scroll when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    setInput('')

    const newHistory = [...messages, { role: 'user', content: text }]
    setMessages(newHistory)

    try {
      const token = await getToken()
      let res
      if (sessionId) {
        // Session-aware chat (has recording context)
        res = await axios.post(
          `${API}/api/session/${sessionId}/chat`,
          { message: text },
          { headers: { Authorization: `Bearer ${token}` } }
        )
      } else {
        // Stateless text-only chat
        res = await axios.post(
          `${API}/api/chat`,
          { message: text, history: messages, context },
          { headers: { Authorization: `Bearer ${token}` } }
        )
      }
      setMessages(prev => [...prev, { role: 'assistant', content: res.data.response }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '⚠ Something went wrong. Please try again.' }])
    } finally {
      setSending(false)
    }
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  return (
    <div className="widget" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div className="widget-title" style={{ marginBottom: 8 }}>
        💬 Chat with your AI Teacher
        {!sessionId && <span style={{ fontWeight: 400, fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: 8 }}>no recording needed</span>}
      </div>

      <div style={{
        flex: 1,
        minHeight: 220,
        maxHeight: 480,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingRight: 4,
      }}>
        {messages.length === 0 && (
          <div style={{
            color: 'var(--text-muted)',
            fontSize: '0.85rem',
            padding: '24px 12px',
            textAlign: 'center',
            lineHeight: 1.6,
          }}>
            {sessionId
              ? 'Your recording has been analyzed above. Ask a follow-up or request a deeper explanation.'
              : 'Ask me anything about your playing — or record a take first for audio analysis.'}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{
              maxWidth: '82%',
              padding: '10px 14px',
              borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
              background: m.role === 'user' ? 'var(--accent)' : 'var(--bg-deep)',
              color: m.role === 'user' ? '#fff' : 'var(--text-1)',
              border: m.role === 'assistant' ? '1px solid var(--border)' : 'none',
              fontSize: '0.88rem',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
            }}>
              {m.content}
            </div>
          </div>
        ))}

        {sending && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{
              padding: '10px 14px',
              background: 'var(--bg-deep)',
              border: '1px solid var(--border)',
              borderRadius: '16px 16px 16px 4px',
              color: 'var(--text-muted)',
              fontSize: '0.85rem',
            }}>
              ✦ Thinking…
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-end' }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask anything… (Enter to send, Shift+Enter for newline)"
          rows={2}
          style={{ flex: 1, resize: 'none', fontSize: '0.88rem' }}
          className="input-field"
          disabled={sending}
        />
        <button
          onClick={sendMessage}
          disabled={sending || !input.trim()}
          style={{ padding: '8px 18px', alignSelf: 'flex-end', flexShrink: 0 }}
          className="btn-primary"
        >
          Send
        </button>
      </div>
    </div>
  )
}

// ── MicrophoneSetupModal ──────────────────────────────────────────────────────
export function MicrophoneSetupModal({ isOpen, onClose, selectedDeviceId, onDeviceChange }) {
  const [permStatus, setPermStatus] = useState('unknown') // unknown | prompt | granted | denied
  const [devices, setDevices] = useState([])
  const [requesting, setRequesting] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    checkPermission()
  }, [isOpen])

  const loadDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const inputs = all.filter(d => d.kind === 'audioinput' && d.deviceId)
      setDevices(inputs)
    } catch { /* ignore */ }
  }

  const checkPermission = async () => {
    if (navigator.permissions) {
      try {
        const result = await navigator.permissions.query({ name: 'microphone' })
        setPermStatus(result.state)
        if (result.state === 'granted') await loadDevices()
        result.onchange = async () => {
          setPermStatus(result.state)
          if (result.state === 'granted') await loadDevices()
        }
        return
      } catch { /* permissions API unavailable */ }
    }
    await loadDevices()
  }

  const requestPermission = async () => {
    setRequesting(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(t => t.stop())
      setPermStatus('granted')
      await loadDevices()
    } catch {
      setPermStatus('denied')
    } finally {
      setRequesting(false)
    }
  }

  if (!isOpen) return null

  const STATUS_MAP = {
    unknown: { color: 'var(--text-3)',  icon: '○', label: 'Unknown' },
    prompt:  { color: 'var(--accent)',  icon: '!', label: 'Not yet granted' },
    granted: { color: 'var(--green)',   icon: '✓', label: 'Granted' },
    denied:  { color: 'var(--red)',     icon: '✗', label: 'Denied' },
  }
  const s = STATUS_MAP[permStatus] || STATUS_MAP.unknown

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ textAlign: 'left', maxWidth: 460 }}>
        <h2 style={{ marginBottom: 6 }}>🎙 Microphone Setup</h2>
        <p>
          Grant microphone access, then choose which input device the app
          uses for recordings and the tuner.
        </p>

        {/* Permission status row */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 14px', marginBottom: 14,
          background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 8,
        }}>
          <span style={{ color: s.color, fontSize: '1.1rem', lineHeight: 1, fontWeight: 700 }}>{s.icon}</span>
          <div>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Browser permission</div>
            <div style={{ color: s.color, fontWeight: 600, fontSize: '0.88rem' }}>{s.label}</div>
          </div>
          {permStatus !== 'granted' && permStatus !== 'denied' && (
            <button
              className="btn"
              style={{ marginLeft: 'auto', padding: '6px 14px', fontSize: '0.82rem' }}
              onClick={requestPermission}
              disabled={requesting}
            >
              {requesting ? 'Requesting…' : 'Allow access'}
            </button>
          )}
          {permStatus === 'granted' && (
            <button
              className="btn"
              style={{ marginLeft: 'auto', padding: '6px 14px', fontSize: '0.82rem' }}
              onClick={loadDevices}
            >
              Refresh
            </button>
          )}
        </div>

        {/* Denied help text */}
        {permStatus === 'denied' && (
          <div style={{
            marginBottom: 14, padding: '10px 14px',
            background: 'var(--red-dim)', border: '1px solid rgba(232,64,64,0.25)',
            borderRadius: 8, fontSize: '0.82rem', lineHeight: 1.6,
          }}>
            <strong style={{ color: 'var(--text-1)' }}>Microphone access was blocked.</strong>
            <div style={{ color: 'var(--text-2)', marginTop: 4 }}>
              Click the 🔒 lock icon in the address bar → <strong>Microphone</strong> → <strong>Allow</strong> → reload the page.
            </div>
          </div>
        )}

        {/* Browser-specific help for not-yet-granted */}
        {(permStatus === 'unknown' || permStatus === 'prompt') && !requesting && (
          <div style={{
            marginBottom: 14, padding: '10px 14px',
            background: 'var(--accent-soft)', border: '1px solid var(--border)',
            borderRadius: 8, fontSize: '0.82rem', lineHeight: 1.6, color: 'var(--text-2)',
          }}>
            Click <strong style={{ color: 'var(--accent)' }}>Allow access</strong> above,
            then accept the browser permission popup that appears.
            If nothing happens, look for the{' '}
            <strong style={{ color: 'var(--text-1)' }}>🔒 / 🎙</strong> icon next to the address bar.
          </div>
        )}

        {/* Device selector */}
        {devices.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <label style={{
              display: 'block', fontSize: '0.68rem', color: 'var(--text-3)',
              textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8,
            }}>
              Audio input device
            </label>
            <select
              className="input-field"
              value={selectedDeviceId || ''}
              onChange={e => onDeviceChange(e.target.value || null)}
            >
              <option value="">Default device</option>
              {devices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone (${d.deviceId.slice(0, 8)}…)`}
                </option>
              ))}
            </select>
          </div>
        )}

        {permStatus === 'granted' && devices.length === 0 && (
          <div style={{ marginBottom: 16, color: 'var(--text-3)', fontSize: '0.84rem' }}>
            No audio input devices found.
          </div>
        )}

        <button
          className="btn"
          style={{ width: '100%', padding: '10px', fontSize: '0.9rem' }}
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>
  )
}
