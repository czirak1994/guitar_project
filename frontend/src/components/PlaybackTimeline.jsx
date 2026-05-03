/**
 * PlaybackTimeline — canvas waveform + beat grid + note markers + live playhead
 *
 * Rendering strategy (performance):
 *   - offscreenRef: static layer (waveform + beats + notes), rebuilt only when data changes
 *   - RAF loop: blits offscreen then draws playhead on top — no per-frame full redraw
 *
 * Props:
 *   audioUrl      – blob URL of the recording (null = static/no-audio mode)
 *   bpm           – tempo for beat grid
 *   detectedNotes – [{ time_s, note, freq_hz, cents }] from /api/analyze
 *   durationSec   – fallback total seconds before audio is decoded
 */
import { useRef, useEffect, useState, useCallback } from 'react'

const H = 110   // canvas height px (intrinsic)

const C = {
  bg:        '#0b0907',
  good:      '#22c55e',
  close:     '#eab308',
  off:       '#ef4444',
  playhead:  '#F5A623',
}

function noteColor(cents) {
  const a = Math.abs(cents ?? 60)
  if (a < 18) return C.good
  if (a < 38) return C.close
  return C.off
}

// ── RMS envelope — much better than min/max ───────────────────────────────────
function buildRMS(channelData, W) {
  const totalSamples = channelData.length
  const step = Math.max(1, Math.floor(totalSamples / W))
  const rms = new Float32Array(W)
  let peak = 0
  for (let x = 0; x < W; x++) {
    let sum = 0, n = 0
    const base = x * step
    for (let j = 0; j < step && base + j < totalSamples; j++) {
      const v = channelData[base + j]
      sum += v * v
      n++
    }
    rms[x] = n > 0 ? Math.sqrt(sum / n) : 0
    if (rms[x] > peak) peak = rms[x]
  }
  // Normalize so the loudest column fills ~80% of half-height
  if (peak > 0) for (let x = 0; x < W; x++) rms[x] /= peak
  return rms
}

// ── Draw the static layer to an offscreen canvas ─────────────────────────────
function buildOffscreen(W, totalSec, audioBuffer, bpm, detectedNotes) {
  const off = document.createElement('canvas')
  off.width  = W
  off.height = H
  const oc   = off.getContext('2d')

  // Background
  oc.fillStyle = C.bg
  oc.fillRect(0, 0, W, H)

  const midY     = H / 2
  const pxPerSec = W / totalSec

  // ── Waveform ───────────────────────────────────────────────────────────────
  if (audioBuffer) {
    const rms = buildRMS(audioBuffer.getChannelData(0), W)

    // Filled gradient envelope (symmetric)
    const grad = oc.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0,    'rgba(245,166,35,0.55)')
    grad.addColorStop(0.35, 'rgba(245,166,35,0.75)')
    grad.addColorStop(0.5,  'rgba(245,166,35,0.85)')
    grad.addColorStop(0.65, 'rgba(245,166,35,0.75)')
    grad.addColorStop(1,    'rgba(245,166,35,0.55)')

    oc.fillStyle = grad
    oc.beginPath()
    oc.moveTo(0, midY)

    // Forward pass — top edge
    for (let x = 0; x < W; x++) {
      oc.lineTo(x, midY - rms[x] * midY * 0.82)
    }
    // Backward pass — bottom edge (mirror)
    for (let x = W - 1; x >= 0; x--) {
      oc.lineTo(x, midY + rms[x] * midY * 0.82)
    }
    oc.closePath()
    oc.fill()

    // Thin bright centre-line
    oc.strokeStyle = 'rgba(245,166,35,0.15)'
    oc.lineWidth   = 0.5
    oc.beginPath()
    oc.moveTo(0, midY)
    oc.lineTo(W, midY)
    oc.stroke()
  }

  // ── Beat grid ─────────────────────────────────────────────────────────────
  const beatSec  = 60 / bpm
  const numBeats = Math.ceil(totalSec / beatSec) + 1
  oc.font = '9px JetBrains Mono, monospace'

  for (let i = 0; i <= numBeats; i++) {
    const x = i * beatSec * pxPerSec
    if (x > W) break
    const isMeasure = i % 4 === 0

    oc.strokeStyle = isMeasure ? 'rgba(245,166,35,0.30)' : 'rgba(245,166,35,0.10)'
    oc.lineWidth   = isMeasure ? 1.2 : 0.6
    oc.beginPath()
    oc.moveTo(x, 0)
    oc.lineTo(x, H)
    oc.stroke()

    if (isMeasure && i > 0) {
      oc.fillStyle = 'rgba(245,166,35,0.5)'
      oc.fillText(`${i / 4 + 1}`, x + 3, 11)
    }
  }

  // ── Note markers ──────────────────────────────────────────────────────────
  detectedNotes.forEach(note => {
    const x   = note.time_s * pxPerSec
    const col = noteColor(note.cents)

    // Glow halo
    oc.globalAlpha = 0.18
    oc.fillStyle   = col
    oc.beginPath()
    oc.arc(x, midY, 12, 0, Math.PI * 2)
    oc.fill()

    // Stem line — full height, thin
    oc.globalAlpha  = 0.5
    oc.strokeStyle  = col
    oc.lineWidth    = 1
    oc.beginPath()
    oc.moveTo(x, 8)
    oc.lineTo(x, H - 8)
    oc.stroke()

    // Dot cap
    oc.globalAlpha = 1
    oc.fillStyle   = col
    oc.shadowColor  = col
    oc.shadowBlur   = 6
    oc.beginPath()
    oc.arc(x, 13, 5, 0, Math.PI * 2)
    oc.fill()
    oc.shadowBlur   = 0

    // Note name
    if (note.note) {
      oc.fillStyle   = 'rgba(255,255,255,0.92)'
      oc.globalAlpha = 0.95
      oc.font        = 'bold 8px JetBrains Mono, monospace'
      const lx = Math.max(2, Math.min(x - 6, W - 26))
      oc.fillText(note.note, lx, 28)
    }
    oc.globalAlpha = 1
    oc.font        = '9px JetBrains Mono, monospace'
  })

  return off
}

// ─────────────────────────────────────────────────────────────────────────────
export default function PlaybackTimeline({ audioUrl, bpm = 120, detectedNotes = [], durationSec = 10 }) {
  const canvasRef    = useRef(null)
  const offscreenRef = useRef(null)
  const ctxRef       = useRef(null)   // AudioContext (for playback)
  const sourceRef    = useRef(null)
  const bufferRef    = useRef(null)
  const rafRef       = useRef(null)
  const startWallRef = useRef(null)
  const seekRef      = useRef(0)
  const totalSecRef  = useRef(durationSec || 10)

  const [isPlaying,  setIsPlaying]  = useState(false)
  const [currentSec, setCurrentSec] = useState(0)
  const [totalSec,   setTotalSec]   = useState(durationSec || 10)
  const [loaded,     setLoaded]     = useState(false)
  const [decoding,   setDecoding]   = useState(false)
  const [noAudio,    setNoAudio]    = useState(!audioUrl)

  // Keep ref in sync for RAF closure
  useEffect(() => { totalSecRef.current = totalSec }, [totalSec])

  // ── Decode audio ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!audioUrl) { setNoAudio(true); return }
    setNoAudio(false)
    setLoaded(false)
    setDecoding(true)
    let cancelled = false

    ;(async () => {
      try {
        const ac  = new (window.AudioContext || window.webkitAudioContext)()
        const res = await fetch(audioUrl)
        const raw = await res.arrayBuffer()
        const buf = await ac.decodeAudioData(raw)
        if (cancelled) { ac.close(); return }
        bufferRef.current = buf
        ctxRef.current    = ac
        setTotalSec(buf.duration)
        setLoaded(true)
      } catch (e) {
        console.warn('[PlaybackTimeline] Audio decode failed:', e.message)
      }
      if (!cancelled) setDecoding(false)
    })()

    return () => { cancelled = true }
  }, [audioUrl])

  // ── Build offscreen whenever static data changes ────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Use displayed width for crisp rendering
    const W = canvas.width
    offscreenRef.current = buildOffscreen(
      W, totalSec,
      loaded ? bufferRef.current : null,
      bpm, detectedNotes
    )
    drawComposite(seekRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, totalSec, bpm, detectedNotes])

  // ── Composite: blit static + playhead ──────────────────────────────────────
  const drawComposite = useCallback((posSec) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W   = canvas.width

    if (offscreenRef.current) {
      ctx.drawImage(offscreenRef.current, 0, 0, W, H)
    } else {
      ctx.fillStyle = C.bg
      ctx.fillRect(0, 0, W, H)
    }

    if (posSec <= 0) return
    const x = Math.min((posSec / totalSecRef.current) * W, W - 1)

    // Tint played region
    ctx.fillStyle = 'rgba(245,166,35,0.06)'
    ctx.fillRect(0, 0, x, H)

    // Glow around playhead
    const g = ctx.createLinearGradient(x - 8, 0, x + 8, 0)
    g.addColorStop(0,   'rgba(245,166,35,0)')
    g.addColorStop(0.5, 'rgba(245,166,35,0.45)')
    g.addColorStop(1,   'rgba(245,166,35,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - 8, 0, 16, H)

    // Playhead line
    ctx.strokeStyle = C.playhead
    ctx.lineWidth   = 2
    ctx.shadowColor = C.playhead
    ctx.shadowBlur  = 6
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, H)
    ctx.stroke()
    ctx.shadowBlur  = 0

    // Triangle cap
    ctx.fillStyle = C.playhead
    ctx.beginPath()
    ctx.moveTo(x - 5, 0)
    ctx.lineTo(x + 5, 0)
    ctx.lineTo(x, 8)
    ctx.closePath()
    ctx.fill()
  }, [])

  useEffect(() => {
    if (!isPlaying) drawComposite(currentSec)
  }, [currentSec, isPlaying, drawComposite])

  // ── RAF tick ────────────────────────────────────────────────────────────────
  const startRAF = useCallback(() => {
    function tick() {
      if (!ctxRef.current || startWallRef.current === null) return
      const elapsed = ctxRef.current.currentTime - startWallRef.current
      const pos = Math.min(elapsed, totalSecRef.current)
      setCurrentSec(pos)
      drawComposite(pos)
      if (pos < totalSecRef.current) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        setIsPlaying(false)
        setCurrentSec(0)
        seekRef.current = 0
        startWallRef.current = null
        drawComposite(0)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [drawComposite])

  // ── Play ─────────────────────────────────────────────────────────────────────
  const play = useCallback(async (fromSec) => {
    if (!bufferRef.current) return
    // FIX: declare 'from' with let
    let from = fromSec !== undefined ? fromSec : seekRef.current

    let ac = ctxRef.current
    if (!ac || ac.state === 'closed') {
      ac = new (window.AudioContext || window.webkitAudioContext)()
      ctxRef.current = ac
    }
    if (ac.state === 'suspended') await ac.resume()

    if (sourceRef.current) {
      try { sourceRef.current.onended = null; sourceRef.current.stop() } catch {}
    }

    const src = ac.createBufferSource()
    src.buffer = bufferRef.current
    src.connect(ac.destination)

    const startFrom = Math.max(0, Math.min(from, bufferRef.current.duration - 0.01))
    src.start(0, startFrom)
    src.onended = () => {
      cancelAnimationFrame(rafRef.current)
      setIsPlaying(false)
      setCurrentSec(0)
      seekRef.current      = 0
      startWallRef.current = null
      drawComposite(0)
    }

    sourceRef.current    = src
    startWallRef.current = ac.currentTime - startFrom
    seekRef.current      = startFrom
    setIsPlaying(true)
    startRAF()
  }, [startRAF, drawComposite])

  // ── Pause ────────────────────────────────────────────────────────────────────
  const pause = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    seekRef.current = currentSec
    if (sourceRef.current) {
      try { sourceRef.current.onended = null; sourceRef.current.stop() } catch {}
    }
    setIsPlaying(false)
  }, [currentSec])

  // ── Click-to-seek ────────────────────────────────────────────────────────────
  const handleCanvasClick = useCallback((e) => {
    const rect   = canvasRef.current.getBoundingClientRect()
    const ratio  = (e.clientX - rect.left) / rect.width
    const seekSec = ratio * totalSecRef.current
    seekRef.current = seekSec
    setCurrentSec(seekSec)
    if (isPlaying) play(seekSec)
    else drawComposite(seekSec)
  }, [isPlaying, play, drawComposite])

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current)
    if (sourceRef.current) try { sourceRef.current.stop() } catch {}
  }, [])

  const fmt     = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const canPlay  = loaded && !noAudio
  const hasNotes = detectedNotes.length > 0

  return (
    <div className="ptl-wrap">

      {/* Canvas */}
      <div className="ptl-canvas-container">
        <canvas
          ref={canvasRef}
          width={720}
          height={H}
          className="ptl-canvas"
          onClick={canPlay || hasNotes ? handleCanvasClick : undefined}
          style={{ cursor: canPlay ? 'crosshair' : 'default' }}
        />
        {noAudio && hasNotes && (
          <div className="ptl-no-audio-banner">
            📭 Audio not stored · saved analysis
          </div>
        )}
        {noAudio && !hasNotes && (
          <div className="ptl-no-data">No recording data available.</div>
        )}
        {decoding && (
          <div className="ptl-loading">Decoding…</div>
        )}
      </div>

      {/* Controls */}
      <div className="ptl-controls">
        {canPlay && (
          <>
            <button
              className="ptl-play-btn"
              onClick={() => isPlaying ? pause() : play()}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>
            <span className="ptl-time">{fmt(currentSec)}</span>
            <span className="ptl-time-sep">/</span>
            <span className="ptl-time-total">{fmt(totalSec)}</span>
            <span className="ptl-seek-hint">Click to seek</span>
          </>
        )}

        {hasNotes && (
          <div className="ptl-legend">
            <span className="ptl-legend-item"><span className="ptl-dot ptl-dot--g" />In tune</span>
            <span className="ptl-legend-item"><span className="ptl-dot ptl-dot--y" />Close</span>
            <span className="ptl-legend-item"><span className="ptl-dot ptl-dot--r" />Off</span>
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="ptl-bpm-label">
        {bpm} BPM
        {hasNotes && ` · ${detectedNotes.length} notes`}
        {!canPlay && !noAudio && !decoding && !loaded && ' · loading…'}
      </div>
    </div>
  )
}
