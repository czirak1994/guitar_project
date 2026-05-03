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

// Visual severity: off-tune notes are visually dominant, good notes are subtle
function noteSeverity(cents) {
  const a = Math.abs(cents ?? 60)
  if (a < 18) return 'good'
  if (a < 38) return 'close'
  return 'off'
}

const H = 110   // canvas height px (intrinsic)

const C = {
  bg:        '#0b0907',
  good:      '#22c55e',
  close:     '#eab308',
  off:       '#ef4444',
  playhead:  '#F5A623',
}

function noteColor(cents) {
  const sev = noteSeverity(cents)
  return C[sev]
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

  // ── Waveform — kept intentionally dim so error markers pop ─────────────────
  if (audioBuffer) {
    const rms = buildRMS(audioBuffer.getChannelData(0), W)

    // Low-opacity gradient — acts as background context only
    const grad = oc.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0,    'rgba(245,166,35,0.15)')
    grad.addColorStop(0.5,  'rgba(245,166,35,0.28)')
    grad.addColorStop(1,    'rgba(245,166,35,0.15)')

    oc.fillStyle = grad
    oc.beginPath()
    oc.moveTo(0, midY)

    // Forward pass — top edge
    for (let x = 0; x < W; x++) {
      oc.lineTo(x, midY - rms[x] * midY * 0.65)
    }
    // Backward pass — bottom edge (mirror)
    for (let x = W - 1; x >= 0; x--) {
      oc.lineTo(x, midY + rms[x] * midY * 0.65)
    }
    oc.closePath()
    oc.fill()

    // Thin centre-line
    oc.strokeStyle = 'rgba(245,166,35,0.08)'
    oc.lineWidth   = 0.5
    oc.beginPath()
    oc.moveTo(0, midY)
    oc.lineTo(W, midY)
    oc.stroke()
  }

  // ── Beat grid — measure lines only to reduce clutter ────────────────────────
  const beatSec  = 60 / bpm
  const numBeats = Math.ceil(totalSec / beatSec) + 1
  oc.font = '9px JetBrains Mono, monospace'

  for (let i = 0; i <= numBeats; i++) {
    const x = i * beatSec * pxPerSec
    if (x > W) break
    if (i % 4 !== 0) continue  // skip individual beat lines

    oc.strokeStyle = 'rgba(245,166,35,0.14)'
    oc.lineWidth   = 1
    oc.beginPath()
    oc.moveTo(x, 0)
    oc.lineTo(x, H)
    oc.stroke()
  }

  // ── Note markers — errors are visually dominant, correct notes are subtle ──
  // Draw good/close notes first so error markers render on top
  const sorted = [...detectedNotes].sort((a, b) => {
    const order = { good: 0, close: 1, off: 2 }
    return order[noteSeverity(a.cents)] - order[noteSeverity(b.cents)]
  })

  sorted.forEach(note => {
    const x   = note.time_s * pxPerSec
    const col = noteColor(note.cents)
    const sev = noteSeverity(note.cents)

    if (sev === 'off') {
      // Large glow halo for errors — immediately visible
      oc.globalAlpha = 0.30
      oc.fillStyle   = col
      oc.beginPath()
      oc.arc(x, midY, 20, 0, Math.PI * 2)
      oc.fill()

      // Full-height stem
      oc.globalAlpha  = 0.65
      oc.strokeStyle  = col
      oc.lineWidth    = 1.5
      oc.beginPath()
      oc.moveTo(x, 0)
      oc.lineTo(x, H)
      oc.stroke()

      // Large bright dot
      oc.globalAlpha  = 1
      oc.fillStyle    = col
      oc.shadowColor  = col
      oc.shadowBlur   = 14
      oc.beginPath()
      oc.arc(x, 12, 7, 0, Math.PI * 2)
      oc.fill()
      oc.shadowBlur   = 0
    } else if (sev === 'close') {
      // Medium halo
      oc.globalAlpha = 0.15
      oc.fillStyle   = col
      oc.beginPath()
      oc.arc(x, midY, 10, 0, Math.PI * 2)
      oc.fill()

      // Small dot
      oc.globalAlpha  = 0.8
      oc.fillStyle    = col
      oc.shadowColor  = col
      oc.shadowBlur   = 5
      oc.beginPath()
      oc.arc(x, 12, 4.5, 0, Math.PI * 2)
      oc.fill()
      oc.shadowBlur   = 0
    } else {
      // 'good' — tiny, barely noticeable
      oc.globalAlpha  = 0.55
      oc.fillStyle    = col
      oc.shadowColor  = col
      oc.shadowBlur   = 3
      oc.beginPath()
      oc.arc(x, 12, 3, 0, Math.PI * 2)
      oc.fill()
      oc.shadowBlur   = 0
    }

    oc.globalAlpha = 1
  })

  return off
}

// ─────────────────────────────────────────────────────────────────────────────
export default function PlaybackTimeline({ audioUrl, bpm = 120, detectedNotes = [], durationSec = 10 }) {
  const canvasRef      = useRef(null)
  const offscreenRef   = useRef(null)
  const ctxRef         = useRef(null)   // AudioContext (for playback)
  const sourceRef      = useRef(null)
  const bufferRef      = useRef(null)
  const rafRef         = useRef(null)
  const startWallRef   = useRef(null)
  const seekRef        = useRef(0)
  const totalSecRef    = useRef(durationSec || 10)
  const snippetTimerRef = useRef(null)  // for marker-click snippet stop

  const [isPlaying,   setIsPlaying]  = useState(false)
  const [currentSec,  setCurrentSec] = useState(0)
  const [totalSec,    setTotalSec]   = useState(durationSec || 10)
  const [loaded,      setLoaded]     = useState(false)
  const [decoding,    setDecoding]   = useState(false)
  const [decodeError, setDecodeError] = useState(false)
  const [noAudio,     setNoAudio]    = useState(!audioUrl)

  // Keep ref in sync for RAF closure
  useEffect(() => { totalSecRef.current = totalSec }, [totalSec])

  // ── Decode audio ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!audioUrl) { setNoAudio(true); return }
    setNoAudio(false)
    setLoaded(false)
    setDecoding(true)
    setDecodeError(false)
    let cancelled = false
    let localAc = null  // track in closure so cleanup can close it if needed

    ;(async () => {
      try {
        localAc = new (window.AudioContext || window.webkitAudioContext)()
        const res = await fetch(audioUrl)
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching audio blob`)
        const raw = await res.arrayBuffer()
        const buf = await localAc.decodeAudioData(raw)
        if (cancelled) { localAc.close(); return }
        // Close previous AC before adopting the new one
        if (ctxRef.current && ctxRef.current !== localAc && ctxRef.current.state !== 'closed') {
          try { ctxRef.current.close() } catch {}
        }
        bufferRef.current = buf
        ctxRef.current    = localAc
        console.debug('[PlaybackTimeline] decoded OK, duration:', buf.duration.toFixed(2), 's')
        setTotalSec(buf.duration)
        setLoaded(true)
      } catch (e) {
        console.warn('[PlaybackTimeline] Audio decode failed:', e.message)
        if (!cancelled) setDecodeError(true)
        // Close the AC if decode failed and it was never adopted
        if (localAc && ctxRef.current !== localAc && localAc.state !== 'closed') {
          try { localAc.close() } catch {}
        }
      }
      if (!cancelled) setDecoding(false)
    })()

    return () => {
      cancelled = true
      // Close localAc only if it was never successfully adopted as ctxRef.current
      if (localAc && ctxRef.current !== localAc && localAc.state !== 'closed') {
        localAc.close().catch(() => {})
      }
    }
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
    // Clear any running snippet timer
    if (snippetTimerRef.current) { clearTimeout(snippetTimerRef.current); snippetTimerRef.current = null }
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
    if (snippetTimerRef.current) { clearTimeout(snippetTimerRef.current); snippetTimerRef.current = null }
    cancelAnimationFrame(rafRef.current)
    seekRef.current = currentSec
    if (sourceRef.current) {
      try { sourceRef.current.onended = null; sourceRef.current.stop() } catch {}
    }
    setIsPlaying(false)
  }, [currentSec])

  // ── Hover — pointer cursor near markers ─────────────────────────────────────
  const handleCanvasMouseMove = useCallback((e) => {
    if (!detectedNotes.length) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect       = canvas.getBoundingClientRect()
    const ratio      = (e.clientX - rect.left) / rect.width
    const hoverSec   = ratio * totalSecRef.current
    const pxPerSec   = canvas.width / totalSecRef.current
    const hitRadiusSec = 20 / pxPerSec
    const nearMarker = detectedNotes.some(n => Math.abs(n.time_s - hoverSec) < hitRadiusSec)
    canvas.style.cursor = nearMarker ? 'pointer' : 'crosshair'
  }, [detectedNotes])

  // ── Click-to-seek / marker-snippet ──────────────────────────────────────────
  const handleCanvasClick = useCallback((e) => {
    const rect    = canvasRef.current.getBoundingClientRect()
    const canvasW = canvasRef.current.width
    const ratio   = (e.clientX - rect.left) / rect.width
    const clickSec = ratio * totalSecRef.current

    // Find nearest note marker within ~20px
    const pxPerSec     = canvasW / totalSecRef.current
    const hitRadiusSec = 20 / pxPerSec
    let nearest = null, minDist = Infinity
    for (const note of detectedNotes) {
      const dist = Math.abs(note.time_s - clickSec)
      if (dist < hitRadiusSec && dist < minDist) { minDist = dist; nearest = note }
    }

    if (nearest && bufferRef.current) {
      // Play a 2-second snippet starting 0.3 s before the marker
      const from = Math.max(0, nearest.time_s - 0.3)
      if (snippetTimerRef.current) clearTimeout(snippetTimerRef.current)
      play(from)
      snippetTimerRef.current = setTimeout(() => {
        snippetTimerRef.current = null
        cancelAnimationFrame(rafRef.current)
        if (sourceRef.current) { try { sourceRef.current.onended = null; sourceRef.current.stop() } catch {} }
        setIsPlaying(false)
        seekRef.current = nearest.time_s
        setCurrentSec(nearest.time_s)
        drawComposite(nearest.time_s)
      }, 2000)
    } else {
      // Normal seek
      if (snippetTimerRef.current) { clearTimeout(snippetTimerRef.current); snippetTimerRef.current = null }
      seekRef.current = clickSec
      setCurrentSec(clickSec)
      if (isPlaying) play(clickSec)
      else drawComposite(clickSec)
    }
  }, [isPlaying, play, drawComposite, detectedNotes])

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current)
    if (snippetTimerRef.current) clearTimeout(snippetTimerRef.current)
    if (sourceRef.current) try { sourceRef.current.stop() } catch {}
  }, [])

  const fmt     = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const canPlay  = loaded && !noAudio
  const hasNotes = detectedNotes.length > 0
  const errNotes = detectedNotes.filter(n => noteSeverity(n.cents) === 'off')

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
          onMouseMove={hasNotes ? handleCanvasMouseMove : undefined}
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
        {decodeError && (
          <div className="ptl-loading" style={{ color: 'var(--red)' }}>Audio decode failed</div>
        )}
        {/* "Click to hear" microcopy near error markers */}
        {hasNotes && canPlay && !decoding && (
          <div style={{
            position: 'absolute', bottom: 4, right: 8,
            fontSize: '0.68rem', color: 'rgba(245,166,35,0.45)',
            pointerEvents: 'none', userSelect: 'none',
          }}>
            {errNotes.length > 0 ? `${errNotes.length} mistake${errNotes.length > 1 ? 's' : ''} — click to hear` : 'Click to seek'}
          </div>
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
