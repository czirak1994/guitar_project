import { useState, useRef } from 'react'

// ── Seeded RNG (deterministic per session metrics) ───────────────────────────
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Combined cell generator (single-row: worst of timing/pitch) ──────────────
function generateCells(onTimeRatio, accuracyPct, timingErrorMs, count) {
  const rand = mulberry32(
    Math.round((onTimeRatio ?? 0.75) * 1000) +
    Math.round((accuracyPct ?? 75) * 7) +
    Math.abs(Math.round(timingErrorMs ?? 0))
  )

  const timingGreenFrac = Math.max(0, Math.min(1, onTimeRatio ?? 0.75))
  const pitchGreenFrac  = Math.max(0, Math.min(1, (accuracyPct ?? 75) / 100))
  const isRushing       = (timingErrorMs ?? 0) < -10

  function classify(greenFrac) {
    const r = rand()
    const yellowFrac = (1 - greenFrac) * 0.45
    if (r < greenFrac) return 'green'
    if (r < greenFrac + yellowFrac) return 'yellow'
    return 'red'
  }

  return Array.from({ length: count }, (_, i) => {
    const timingState = classify(timingGreenFrac)
    const pitchState  = classify(pitchGreenFrac)

    // Combined: worst of the two
    const stateRank = { green: 0, yellow: 1, red: 2 }
    const combined = stateRank[timingState] >= stateRank[pitchState] ? timingState : pitchState

    // Tooltip — plain language, no music theory
    let tooltip = 'Good — this moment was clean.'
    if (combined === 'yellow') {
      tooltip = timingState === 'yellow'
        ? (isRushing ? 'You rushed slightly here.' : 'You slowed down a little here.')
        : 'The note was slightly off here.'
    }
    if (combined === 'red') {
      if (timingState === 'red' && pitchState === 'red') tooltip = 'Both timing and note were off here.'
      else if (timingState === 'red') tooltip = isRushing ? 'You rushed badly here.' : 'You were late here.'
      else tooltip = 'Wrong note here.'
    }

    return { index: i + 1, state: combined, tooltip }
  })
}

// ── Audio slice playback via Web Audio API ───────────────────────────────────
let sharedAudioBuffer = null   // cached so we only decode once per session
let sharedAudioUrl    = null

async function playSlice(audioUrl, startSec, sliceDurationSec, onDone) {
  try {
    // Decode audio once per URL
    if (audioUrl !== sharedAudioUrl || !sharedAudioBuffer) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const res = await fetch(audioUrl)
      const raw = await res.arrayBuffer()
      sharedAudioBuffer = await ctx.decodeAudioData(raw)
      sharedAudioUrl    = audioUrl
    }

    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const source = ctx.createBufferSource()
    source.buffer = sharedAudioBuffer
    source.connect(ctx.destination)
    source.start(0, Math.max(0, startSec), Math.min(sliceDurationSec, sharedAudioBuffer.duration - startSec))
    source.onended = () => { onDone(); ctx.close() }
  } catch {
    onDone()
  }
}

// ── BeatCircle ────────────────────────────────────────────────────────────────
function BeatCircle({ cell, delayMs, sliceStart, sliceDuration, audioUrl, isPlaying, onPlay, onStop }) {
  const { state, tooltip, index } = cell

  const handleClick = () => {
    if (!audioUrl) return
    if (isPlaying) { onStop(); return }
    onPlay(index)
    playSlice(audioUrl, sliceStart, sliceDuration, onStop)
  }

  return (
    <div className="beat-cell">
      <div
        className={[
          'beat-circle',
          `beat-circle--${state}`,
          isPlaying ? 'beat-circle--playing' : '',
          state === 'red' ? 'beat-circle--pulsing' : '',
          audioUrl ? 'beat-circle--clickable' : '',
        ].join(' ')}
        style={{ animationDelay: `${delayMs}ms` }}
        onClick={handleClick}
        title={tooltip}
        aria-label={`Beat ${index}: ${tooltip}`}
        role={audioUrl ? 'button' : undefined}
      >
        {isPlaying
          ? <span className="beat-circle-playing-icon">▶</span>
          : <span className="beat-circle-index">{index}</span>
        }
      </div>
    </div>
  )
}

// ── FeedbackGrid ──────────────────────────────────────────────────────────────
/**
 * Props:
 *   onTimeRatio    – float 0–1   (latestMetrics.on_time_ratio)
 *   accuracyPct    – float 0–100 (latestMetrics.accuracy_pct)
 *   timingErrorMs  – float ms    (latestMetrics.timing_error_ms)
 *   audioUrl       – string|null – if provided, circles are clickable to play that beat
 *   recordingDurationSec – estimated recording length (default 10s)
 *   beatCount      – how many circles (default 8)
 */
export default function FeedbackGrid({
  onTimeRatio,
  accuracyPct,
  timingErrorMs,
  audioUrl = null,
  recordingDurationSec = 10,
  beatCount = 8,
}) {
  const [playingIndex, setPlayingIndex] = useState(null)

  const cells         = generateCells(onTimeRatio, accuracyPct, timingErrorMs, beatCount)
  const sliceDuration = recordingDurationSec / beatCount

  const timingScore  = Math.round((onTimeRatio ?? 0.75) * 100)
  const pitchScore   = Math.round(accuracyPct ?? 75)
  const overallScore = Math.round((timingScore + pitchScore) / 2)
  const greenCount   = cells.filter(c => c.state === 'green').length
  const isRushing    = (timingErrorMs ?? 0) < -10

  // ── 1-line plain-language summary ────────────────────────────────────────
  const oneLiner = (() => {
    if (overallScore >= 90) return 'Great — almost everything was clean! 🎉'
    if (overallScore >= 75) return `Good job. ${greenCount} of ${beatCount} moments were clean.`
    if (timingScore < pitchScore) return isRushing
      ? `Your timing was the main issue — you kept rushing.`
      : `Your timing drifted — try to stay more steady.`
    if (pitchScore < timingScore) return `Your timing was good but some notes were off.`
    return `Both timing and notes need work — take it slower.`
  })()

  const scoreColor = overallScore >= 75 ? 'var(--green)'
    : overallScore >= 50 ? 'var(--yellow)'
    : 'var(--red)'

  return (
    <div className="feedback-grid-wrap">

      {/* Score + summary */}
      <div className="fg-hero">
        <div className="fg-hero-left">
          <span className="fg-score" style={{ color: scoreColor }}>
            {greenCount}/{beatCount}
          </span>
          <span className="fg-score-label">clean</span>
        </div>
        <span className="fg-one-liner">{oneLiner}</span>
      </div>

      {/* Circle row */}
      <div className="fg-circles">
        {cells.map((cell, i) => (
          <BeatCircle
            key={i}
            cell={cell}
            delayMs={i * 60}
            sliceStart={i * sliceDuration}
            sliceDuration={sliceDuration}
            audioUrl={audioUrl}
            isPlaying={playingIndex === cell.index}
            onPlay={(idx) => setPlayingIndex(idx)}
            onStop={() => setPlayingIndex(null)}
          />
        ))}
      </div>

      {/* Interaction hint */}
      {audioUrl && (
        <div className="fg-hint">
          <span className="fg-hint-icon">👆</span>
          <span>Tap any circle to hear that exact moment</span>
          <span className="fg-legend">
            <span className="fg-dot fg-dot--green" /> Good
            <span className="fg-dot fg-dot--yellow" /> Close
            <span className="fg-dot fg-dot--red" /> Fix this
          </span>
        </div>
      )}
      {!audioUrl && (
        <div className="fg-hint fg-hint--no-audio">
          <span className="fg-legend">
            <span className="fg-dot fg-dot--green" /> Good
            <span className="fg-dot fg-dot--yellow" /> Close
            <span className="fg-dot fg-dot--red" /> Fix this
          </span>
        </div>
      )}
    </div>
  )
}
