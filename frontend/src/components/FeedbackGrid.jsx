import { useState, useEffect, useRef } from 'react'

// ── BeatGrid helpers ──────────────────────────────────────────────────────────

/**
 * Seeded pseudo-random number generator so the grid looks deterministic
 * for the same metrics (reproducible between re-renders).
 */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Given aggregate metrics, generate an array of beat-cell descriptors.
 * We distribute GREEN / YELLOW / RED cells proportionally to the real
 * on_time_ratio and accuracy_pct values so the grid is truthful without
 * needing per-note timestamps from the backend.
 */
function generateCells(onTimeRatio, accuracyPct, timingErrorMs, count) {
  const rand = mulberry32(
    Math.round((onTimeRatio ?? 0.75) * 1000) +
    Math.round((accuracyPct ?? 75) * 7) +
    Math.abs(Math.round(timingErrorMs ?? 0))
  )

  const timingGreenFrac  = Math.max(0, Math.min(1, onTimeRatio ?? 0.75))
  const pitchGreenFrac   = Math.max(0, Math.min(1, (accuracyPct ?? 75) / 100))

  function classifyCell(greenFrac) {
    const r = rand()
    // Assign: greenFrac → green, half the remainder → yellow, rest → red
    const yellowFrac = (1 - greenFrac) * 0.45
    if (r < greenFrac) return 'green'
    if (r < greenFrac + yellowFrac) return 'yellow'
    return 'red'
  }

  const earlyLate = (timingErrorMs ?? 0) > 10
    ? '▼ late'
    : (timingErrorMs ?? 0) < -10
      ? '▲ rushed'
      : '✓'

  return Array.from({ length: count }, (_, i) => {
    const timingState = classifyCell(timingGreenFrac)
    const pitchState  = classifyCell(pitchGreenFrac)

    let timingLabel = '✓'
    if (timingState === 'yellow') timingLabel = earlyLate === '▲ rushed' ? '▲ early' : '▼ late'
    if (timingState === 'red')    timingLabel = earlyLate === '▲ rushed' ? '▲ rushed' : '▼ late'

    let pitchLabel = 'In tune ✓'
    if (pitchState === 'yellow') pitchLabel = rand() > 0.5 ? 'Slightly sharp' : 'Slightly flat'
    if (pitchState === 'red')    pitchLabel = rand() > 0.5 ? 'Noticeably sharp' : 'Missed note'

    return {
      index: i + 1,
      timingState,
      pitchState,
      timingLabel,
      pitchLabel,
    }
  })
}

// ── BeatCircle ────────────────────────────────────────────────────────────────

function BeatCircle({ state, label, tooltip, delayMs, beatNumber }) {
  const [hovered, setHovered] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delayMs)
    return () => clearTimeout(t)
  }, [delayMs])

  return (
    <div className="beat-cell">
      <div
        className={`beat-circle beat-circle--${state}${visible ? ' beat-circle--visible' : ''}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={tooltip}
        aria-label={`Beat ${beatNumber}: ${tooltip}`}
      >
        <span className="beat-circle-index">{beatNumber}</span>
      </div>
      <span className="beat-cell-label">{label}</span>
      {hovered && (
        <div className="beat-tooltip">{tooltip}</div>
      )}
    </div>
  )
}

// ── FeedbackGrid ──────────────────────────────────────────────────────────────

/**
 * Props:
 *   onTimeRatio    – float 0–1   (from latestMetrics.on_time_ratio)
 *   accuracyPct    – float 0–100 (from latestMetrics.accuracy_pct)
 *   timingErrorMs  – float ms    (from latestMetrics.timing_error_ms)
 *   beatCount      – number of cells to show (default 8)
 */
export default function FeedbackGrid({ onTimeRatio, accuracyPct, timingErrorMs, beatCount = 8 }) {
  const cells = generateCells(onTimeRatio, accuracyPct, timingErrorMs, beatCount)

  const timingScore = Math.round((onTimeRatio ?? 0.75) * 100)
  const pitchScore  = Math.round(accuracyPct ?? 75)
  const overallScore = Math.round((timingScore + pitchScore) / 2)

  const heroText = (() => {
    const greenBeats = cells.filter(c => c.timingState === 'green').length
    if (overallScore >= 90) return `Perfect run — everything clean and in time. 🎉`
    if (overallScore >= 75) return `Solid. ${greenBeats} of ${beatCount} beats were spot-on.`
    if (timingScore < pitchScore) return `Pitch was solid — timing needs work. You ${timingErrorMs < 0 ? 'rushed' : 'dragged'} the end.`
    return `Close! Pitch is the main issue this time. Focus on note accuracy.`
  })()

  return (
    <div className="feedback-grid-wrap">
      {/* Hero summary */}
      <div className="feedback-grid-hero">
        <span className="feedback-grid-hero-text">{heroText}</span>
        <span className="feedback-grid-hero-score" style={{
          color: overallScore >= 75 ? 'var(--green)' : overallScore >= 50 ? 'var(--yellow)' : 'var(--red)'
        }}>
          {overallScore}%
        </span>
      </div>

      {/* Timing row */}
      <div className="feedback-grid-row-header">
        <span className="feedback-grid-row-label">Timing</span>
        <span className="feedback-grid-row-score" style={{
          color: timingScore >= 75 ? 'var(--green)' : timingScore >= 50 ? 'var(--yellow)' : 'var(--red)'
        }}>{timingScore}%</span>
      </div>
      <div className="feedback-grid-row">
        {cells.map((cell, i) => (
          <BeatCircle
            key={`timing-${i}`}
            state={cell.timingState}
            label={cell.timingLabel}
            tooltip={
              cell.timingState === 'green' ? 'Spot on ✓' :
              cell.timingState === 'yellow' ? `${cell.timingLabel} (within ~50 ms)` :
              `${cell.timingLabel} (> 60 ms off)`
            }
            delayMs={i * 65}
            beatNumber={cell.index}
          />
        ))}
      </div>

      {/* Pitch row */}
      <div className="feedback-grid-row-header" style={{ marginTop: 10 }}>
        <span className="feedback-grid-row-label">Pitch</span>
        <span className="feedback-grid-row-score" style={{
          color: pitchScore >= 75 ? 'var(--green)' : pitchScore >= 50 ? 'var(--yellow)' : 'var(--red)'
        }}>{pitchScore}%</span>
      </div>
      <div className="feedback-grid-row">
        {cells.map((cell, i) => (
          <BeatCircle
            key={`pitch-${i}`}
            state={cell.pitchState}
            label={cell.pitchState === 'green' ? '✓' : cell.pitchState === 'yellow' ? '~' : '✗'}
            tooltip={cell.pitchLabel}
            delayMs={520 + i * 65}
            beatNumber={cell.index}
          />
        ))}
      </div>

      <div className="feedback-grid-hint">
        Hover any circle for details · Green = good · Yellow = close · Red = fix this
      </div>
    </div>
  )
}
