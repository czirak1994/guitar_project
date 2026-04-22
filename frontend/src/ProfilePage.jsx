import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, UserButton } from '@clerk/clerk-react'
import axios from 'axios'
import './App.css'
import './ProfilePage.css'

export default function ProfilePage() {
  const { getToken, isLoaded, isSignedIn } = useAuth()
  const navigate = useNavigate()

  const [profile, setProfile] = useState(null)
  const [stats, setStats] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [portalLoading, setPortalLoading] = useState(false)
  const [upgradeLoading, setUpgradeLoading] = useState(false)
  const [error, setError] = useState(null)

  // Editable fields
  const [skillLevel, setSkillLevel] = useState('')
  const [goal, setGoal] = useState('')
  const [language, setLanguage] = useState('English')

  useEffect(() => {
    if (!isLoaded) return
    if (!isSignedIn) { navigate('/'); return }

    getToken().then(jwt => {
      axios.get('/api/profile', { headers: { Authorization: `Bearer ${jwt}` } })
        .then(res => {
          setProfile(res.data)
          setSkillLevel(res.data.skill_level || '')
          setGoal(res.data.goal || '')
          setLanguage(res.data.language || 'English')
        })
        .catch(err => setError('Failed to load profile'))

      axios.get('/api/stats', { headers: { Authorization: `Bearer ${jwt}` } })
        .then(res => setStats(res.data))
        .catch(() => {}) // stats are optional
    })
  }, [isLoaded, isSignedIn, getToken, navigate])

  // Fix bfcache: when user presses Back from Stripe checkout,
  // the browser may restore a cached page with stale loading state.
  useEffect(() => {
    const handlePageShow = (e) => {
      if (e.persisted) {
        setUpgradeLoading(false)
        setPortalLoading(false)
      }
    }
    window.addEventListener('pageshow', handlePageShow)
    return () => window.removeEventListener('pageshow', handlePageShow)
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    try {
      const jwt = await getToken()
      await axios.post('/api/profile', { skill_level: skillLevel, goal, language }, {
        headers: { Authorization: `Bearer ${jwt}` }
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError('Could not save profile. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleManageBilling = async () => {
    setPortalLoading(true)
    try {
      const jwt = await getToken()
      const { data } = await axios.post('/api/billing-portal', {}, {
        headers: { Authorization: `Bearer ${jwt}` }
      })
      window.location.href = data.url
    } catch (e) {
      setError('Could not open billing portal. Please try again.')
      setPortalLoading(false)
    }
  }

  const handleUpgrade = async () => {
    setUpgradeLoading(true)
    try {
      const jwt = await getToken()
      const { data } = await axios.post('/api/create-checkout-session', {}, {
        headers: { Authorization: `Bearer ${jwt}` }
      })
      window.location.href = data.url
    } catch (e) {
      setError('Could not start checkout. Please try again.')
      setUpgradeLoading(false)
    }
  }

  const isPro = profile?.plan === 'pro'

  return (
    <div className="profile-page">
      {/* Header */}
      <header className="app-header">
        <div className="app-title">ToneSense</div>
        <div className="header-right">
          <button className="header-profile-btn" onClick={() => navigate('/')}>
            ← Back to Studio
          </button>
          <UserButton appearance={{ elements: { userButtonAvatarBox: { width: 28, height: 28 } } }} />
        </div>
      </header>

      <div className="profile-content">
        {error && (
          <div className="profile-error">
            ⚠ {error}
            <button onClick={() => setError(null)} className="profile-error-dismiss">×</button>
          </div>
        )}

        {/* ── Practice Statistics ──────────────────── */}
        <section className="profile-section">
          <h2 className="profile-section-title">Practice Statistics</h2>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-card-value" style={{ color: 'var(--accent)' }}>
                {profile?.streak_days ?? '—'}
              </div>
              <div className="stat-card-label">Day Streak</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-value">
                {stats?.total_sessions ?? '—'}
              </div>
              <div className="stat-card-label">Total Sessions</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-value" style={{ color: 'var(--green)' }}>
                {stats?.best_accuracy != null ? `${stats.best_accuracy.toFixed(0)}%` : '—'}
              </div>
              <div className="stat-card-label">Best Accuracy</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-value">
                {stats?.member_since ?? '—'}
              </div>
              <div className="stat-card-label">Member Since</div>
            </div>
          </div>

          {profile?.current_focus && (
            <div className="profile-focus-box">
              <span className="profile-focus-label">Current Focus</span>
              <span className="profile-focus-text">{profile.current_focus}</span>
            </div>
          )}
        </section>

        {/* ── Learning Profile ─────────────────────── */}
        <section className="profile-section">
          <h2 className="profile-section-title">Learning Profile</h2>
          <div className="profile-form-grid">
            <div className="field">
              <label>Skill Level</label>
              <select value={skillLevel} onChange={e => setSkillLevel(e.target.value)}>
                <option value="">Not set</option>
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
              </select>
            </div>
            <div className="field">
              <label>Primary Goal</label>
              <select value={goal} onChange={e => setGoal(e.target.value)}>
                <option value="">Not set</option>
                <option value="timing">Timing &amp; Rhythm</option>
                <option value="soloing">Soloing &amp; Phrasing</option>
                <option value="technique">Clean Technique</option>
                <option value="speed">Building Speed</option>
              </select>
            </div>
            <div className="field">
              <label>AI Feedback Language</label>
              <select value={language} onChange={e => setLanguage(e.target.value)}>
                <option value="English">English</option>
                <option value="Magyar (Hungarian)">Magyar (Hungarian)</option>
                <option value="Español (Spanish)">Español (Spanish)</option>
                <option value="Deutsch (German)">Deutsch (German)</option>
                <option value="Français (French)">Français (French)</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              className="btn btn-accent"
              onClick={handleSave}
              disabled={saving}
              style={{ padding: '9px 24px', fontSize: '0.85rem' }}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
            {saved && (
              <span style={{ color: 'var(--green)', fontSize: '0.82rem', fontWeight: 500 }}>
                ✓ Saved
              </span>
            )}
          </div>
        </section>

        {/* ── Subscription ─────────────────────────── */}
        <section className="profile-section">
          <h2 className="profile-section-title">Subscription</h2>
          <div className="subscription-card">
            <div className="sub-plan-badge" data-plan={isPro ? 'pro' : 'free'}>
              {isPro ? 'PRO' : 'FREE'}
            </div>
            <div className="sub-plan-info">
              {isPro ? (
                <>
                  <div className="sub-plan-name">ToneSense Pro</div>
                  <div className="sub-plan-desc">Unlimited analyses · Priority AI processing · Advanced insights</div>
                </>
              ) : (
                <>
                  <div className="sub-plan-name">Free Plan</div>
                  <div className="sub-plan-desc">5 analyses per day · Standard AI feedback</div>
                </>
              )}
            </div>
            <div className="sub-plan-action">
              {isPro ? (
                <button
                  className="btn"
                  onClick={handleManageBilling}
                  disabled={portalLoading}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {portalLoading ? 'Opening…' : 'Manage Billing →'}
                </button>
              ) : (
                <button
                  className="btn btn-accent"
                  onClick={handleUpgrade}
                  disabled={upgradeLoading}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {upgradeLoading ? 'Redirecting…' : 'Upgrade to PRO →'}
                </button>
              )}
            </div>
          </div>
          {isPro && (
            <p style={{ fontSize: '0.76rem', color: 'var(--text-3)', marginTop: 10 }}>
              Billing is managed by Stripe. You can cancel, update your payment method, or download invoices from the billing portal.
            </p>
          )}
        </section>

        {/* ── Account ──────────────────────────────── */}
        <section className="profile-section">
          <h2 className="profile-section-title">Account</h2>
          <p style={{ fontSize: '0.84rem', color: 'var(--text-3)', marginBottom: 14 }}>
            Manage your email, password, and connected accounts via Clerk.
          </p>
          <UserButton
            appearance={{ elements: { userButtonAvatarBox: { width: 36, height: 36 } } }}
            showName
          />
        </section>
      </div>
    </div>
  )
}
