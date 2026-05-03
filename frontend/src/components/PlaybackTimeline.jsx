/**
 * PlaybackTimeline — canvas waveform + beat grid + note markers + live playhead
 *
 * v3 fixes:
 *   - AUDIO: fresh AudioContext created inside play() (user-gesture context)
 *     Decode-time AC was auto-suspended by browser autoplay policy → no sound.
 *     Now: decode with a temporary AC (immediately closed), store AudioBuffer.
 *     play() always creates a brand-new AC from the click handler — guaranteed running.
 *   - DPR: ResizeObserver tracks CSS container width; canvas intrinsic pixels = cssW * dpr.
 *     All drawing uses logical (CSS) coordinates via oc.scale(dpr, dpr).
 *   - Visual: error markers dominant, good notes subtle, waveform background-only.
 */
import { useRef, useEffect, useState, useCallback } from 'react'

// Visual severity: off-tune notes are visually dominant, good notes are subtle
function noteSeverity(cents) {
  const a = Math.abs(cents ?? 60)
  if (a < 18) return 'good'
  if (a < 38) return 'close'
  return 'off'
}

const H = 110   // logical canvas height (CSS pixels)

const C = {
  bg:        '#0b0907',
  good:      '#22c55e',
  close:     '#eab308',
  off:       '#ef4444',
  playhead:  '#F5A623',
}

function noteColor(cents) {
  return C[noteSeverity(cents)]
}

// ── RMS envelope ──────────────────────────────────────────────────────────────
function buildRMS(channelData, W) {
  const totalSamples = channelData.length
  const step = Math.max(1, Math.floor(totalSamples / W))
  const rms = new Float32Array(W)
  let peak = 0
  for (let x = 0; x < W; x++) {
    let sum = 0, n = 0
    const base = x * step
    for (let j = 0; j < step && base + j < totalSamples; j++) {
      const v = channelData[base + j]; sum += v * v; n++
    }
    rms[x] = n > 0 ? Math.sqrt(sum / n) : 0
    if (rms[x] > peak) peak = rms[x]
  }
  if (peak > 0) for (let x = 0; x < W; x++) rms[x] /= peak
  return rms
}

/**
 * Build static layer.
 * physW/physH = physical (device) pixels.
 * dpr = devicePixelRatio — context is scaled so all drawing is in logical (CSS) coords.
 */
function buildOffscreen(physW, physH, totalSec, audioBuffer, bpm, detectedNotes, dpr) {
  const off = document.createElement('canvas')
  off.width  = physW
  off.height = physH
  const oc   = off.getContext('2d')

  // Scale once — draw everything in logical (CSS-pixel) coords
  oc.scale(dpr, dpr)
  const lW    = physW / dpr   // logical width
  const lH    = physH / dpr   // logical height
  const midY  = lH / 2
  const pxPerSec = lW / totalSec

  // Background
  oc.fillStyle = C.bg
  oc.fillRect(0, 0, lW, lH)

  // ── Waveform — intentionally dim so error markers pop ─────────────────────
  if (audioBuffer) {
    const rms  = buildRMS(audioBuffer.getChannelData(0), Math.round(lW))
    const grad = oc.createLinearGradient(0, 0, 0, lH)
    grad.addColorStop(0,   'rgba(245,166,35,0.15)')
    grad.addColorStop(0.5, 'rgba(245,166,35,0.30)')
    grad.addColorStop(1,   'rgba(245,166,35,0.15)')
    oc.fillStyle = grad
    oc.beginPath()
    oc.moveTo(0, midY)
    for (let x = 0; x < Math.round(lW); x++) oc.lineTo(x, midY - rms[x] * midY * 0.65)
    for (let x = Math.round(lW) - 1; x >= 0; x--) oc.lineTo(x, midY + rms[x] * midY * 0.65)
    oc.closePath()
    oc.fill()
    oc.strokeStyle = 'rgba(245,166,35,0.08)'
    oc.lineWidth   = 0.5
    oc.beginPath(); oc.moveTo(0, midY); oc.lineTo(lW, midY); oc.stroke()
  }

  // ── Beat grid — measure lines only ────────────────────────────────────────
  const beatSec  = 60 / bpm
  const numBeats = Math.ceil(totalSec / beatSec) + 1
  for (let i = 0; i <= numBeats; i++) {
    if (i % 4 !== 0) continue
    const x = i * beatSec * pxPerSec
    if (x > lW) break
    oc.strokeStyle = 'rgba(245,166,35,0.14)'
    oc.lineWidth   = 1
    oc.beginPath(); oc.moveTo(x, 0); oc.lineTo(x, lH); oc.stroke()
  }

  // ── Note markers — errors dominant, good notes subtle ─────────────────────
  const sorted = [...detectedNotes].sort((a, b) => {
    const order = { good: 0, close: 1, off: 2 }
    return order[noteSeverity(a.cents)] - order[noteSeverity(b.cents)]
  })

  sorted.forEach(note => {
    const x   = note.time_s * pxPerSec
    const col = noteColor(note.cents)
    const sev = noteSeverity(note.cents)

    if (sev === 'off') {
      oc.globalAlpha = 0.28; oc.fillStyle = col
      oc.beginPath(); oc.arc(x, midY, 20, 0, Math.PI * 2); oc.fill()
      oc.globalAlpha = 0.65; oc.strokeStyle = col; oc.lineWidth = 1.5
      oc.beginPath(); oc.moveTo(x, 0); oc.lineTo(x, lH); oc.stroke()
      oc.globalAlpha = 1; oc.fillStyle = col; oc.shadowColor = col; oc.shadowBlur = 14
      oc.beginPath(); oc.arc(x, 12, 7, 0, Math.PI * 2); oc.fill()
      oc.shadowBlur = 0
    } else if (sev === 'close') {
      oc.globalAlpha = 0.15; oc.fillStyle = col
      oc.beginPath(); oc.arc(x, midY, 10, 0, Math.PI * 2); oc.fill()
      oc.globalAlpha = 0.8; oc.fillStyle = col; oc.shadowColor = col; oc.shadowBlur = 5
      oc.beginPath(); oc.arc(x, 12, 4.5, 0, Math.PI * 2); oc.fill()
      oc.shadowBlur = 0
    } else {
      oc.globalAlpha = 0.50; oc.fillStyle = col; oc.shadowColor = col; oc.shadowBlur = 3
      oc.beginPath(); oc.arc(x, 12, 3, 0, Math.PI * 2); oc.fill()
      oc.shadowBlur = 0
    }
    oc.globalAlpha = 1
  })

  return off
}

// ─────────────────────────────────────────────────────────────────────────────
export default function PlaybackTimeline({ audioUrl, bpm = 120, detectedNotes = [], durationSec = 10 }) {
  const containerRef   = useRef(null)   // wrapping div — observed for width
  const canvasRef      = useRef(null)
  const offscreenRef   = useRef(null)
  // ── Playback: separate from decode so we always create AC from user gesture ──
  const playAcRef      = useRef(null)   // dedicated playback AudioContext
  const sourceRef      = useRef(null)
  const bufferRef      = useRef(null)   // decoded AudioBuffer (reused across plays)
  const rafRef         = useRef(null)
  const startWallRef   = useRef(null)
  const seekRef        = useRef(0)
  const totalSecRef    = useRef(durationSec || 10)
  const snippetTimerRef = useRef(null)

  // CSS pixel width of container — drives canvas physical size
  const [cssW, setCssW]       = useState(0)
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1

  const [isPlaying,   setIsPlaying]   = useState(false)
  const [currentSec,  setCurrentSec]  = useState(0)
  const [totalSec,    setTotalSec]    = useState(durationSec || 10)
  const [loaded,      setLoaded]      = useState(false)
  const [decoding,    setDecoding]    = useState(false)
  const [decodeError, setDecodeError] = useState(false)
  const [noAudio,     setNoAudio]     = useState(!audioUrl)

  useEffect(() => { totalSecRef.current = totalSec }, [totalSec])

  // ── Measure container → drive canvas physical pixels ─────────────────────
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const w = el.getBoundingClientRect().width
      if (w > 0) setCssW(w)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const physW = Math.round((cssW || 720) * dpr)
  const physH = Math.round(H * dpr)

  // ── Decode audio ──────────────────────────────────────────────────────────
  // KEY: we decode with a temporary AC that is IMMEDIATELY closed after decode.
  // The bufferRef (AudioBuffer) is reused for all subsequent play() calls.
  // play() creates its own fresh AudioContext from user gesture — never suspended.
  useEffect(() => {
    if (!audioUrl) { setNoAudio(true); return }
    setNoAudio(false)
    setLoaded(false)
    setDecoding(true)
    setDecodeError(false)
    let cancelled = false

    ;(async () => {
      let tmpAc = null
      try {
        const res = await fetch(audioUrl)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const raw = await res.arrayBuffer()
        if (cancelled) return

        // Temporary AC only for decoding — close it immediately after
        tmpAc = new (window.AudioContext || window.webkitAudioContext)()
        const buf = await tmpAc.decodeAudioData(raw)
        tmpAc.close().catch(() => {})
        tmpAc = null

        if (cancelled) return
        bufferRef.current = buf
        console.debug('[PlaybackTimeline] decoded, duration:', buf.duration.toFixed(2), 's')
        setTotalSec(buf.duration)
        setLoaded(true)
      } catch (e) {
        console.warn('[PlaybackTimeline] decode failed:', e.message)
        if (tmpAc) { try { tmpAc.close() } catch {} }
        if (!cancelled) setDecodeError(true)
      }
      if (!cancelled) setDecoding(false)
    })()

    return () => { cancelled = true }
  }, [audioUrl])

  // ── Build offscreen whenever data or canvas size changes ──────────────────
  useEffect(() => {
    if (!canvasRef.current || physW === 0) return
    offscreenRef.current = buildOffscreen(
      physW, physH, totalSec,
      loaded ? bufferRef.current : null,
      bpm, detectedNotes, dpr
    )
    drawComposite(seekRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, totalSec, bpm, detectedNotes, physW, physH])

  // ── Composite: blit static offscreen + playhead ───────────────────────────
  const drawComposite = useCallback((posSec) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cW  = canvas.width   // physical pixels
    const cH  = canvas.height

    if (offscreenRef.current) {
      ctx.drawImage(offscreenRef.current, 0, 0)
    } else {
      ctx.fillStyle = C.bg
      ctx.fillRect(0, 0, cW, cH)
    }

    if (posSec <= 0) return

    // Draw playhead in logical (CSS-pixel) coordinates
    const d  = window.devicePixelRatio || 1
    const lW = cW / d
    const lH = cH / d
    const x  = Math.min((posSec / totalSecRef.current) * lW, lW - 1)

    ctx.save()
    ctx.scale(d, d)

    ctx.fillStyle = 'rgba(245,166,35,0.06)'
    ctx.fillRect(0, 0, x, lH)

    const g = ctx.createLinearGradient(x - 8, 0, x + 8, 0)
    g.addColorStop(0,   'rgba(245,166,35,0)')
    g.addColorStop(0.5, 'rgba(245,166,35,0.45)')
    g.addColorStop(1,   'rgba(245,166,35,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - 8, 0, 16, lH)

    ctx.strokeStyle = C.playhead; ctx.lineWidth = 2
    ctx.shadowColor = C.playhead; ctx.shadowBlur = 6
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, lH); ctx.stroke()
    ctx.shadowBlur = 0

    ctx.fillStyle = C.playhead
    ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8); ctx.closePath(); ctx.fill()

    ctx.restore()
  }, [])

  useEffect(() => {
    if (!isPlaying) drawComposite(currentSec)
  }, [currentSec, isPlaying, drawComposite])

  // ── RAF tick ──────────────────────────────────────────────────────────────
  const startRAF = useCallback(() => {
    function tick() {
      const ac = playAcRef.current
      if (!ac || startWallRef.current === null) return
      const elapsed = ac.currentTime - startWallRef.current
      const pos = Math.min(elapsed, totalSecRef.current)
      setCurrentSec(pos)
      drawComposite(pos)
      if (pos < totalSecRef.current) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        setIsPlaying(false); setCurrentSec(0)
        seekRef.current = 0; startWallRef.current = null
        drawComposite(0)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [drawComposite])

  // ── Play — fresh AudioContext every time (called from user gesture) ────────
  // Creating AudioContext inside an onClick handler guarantees it starts
  // in 'running' state on all browsers — no resume() needed, no autoplay block.
  const play = useCallback(async (fromSec) => {
    if (!bufferRef.current) return
    if (snippetTimerRef.current) { clearTimeout(snippetTimerRef.current); snippetTimerRef.current = null }

    // Stop any current source
    if (sourceRef.current) {
      try { sourceRef.current.onended = null; sourceRef.current.stop() } catch {}
    }

    // Close old playback AC and create a fresh one from this user-gesture context
    if (playAcRef.current && playAcRef.current.state !== 'closed') {
      try { playAcRef.current.close() } catch {}
    }
    const ac = new (window.AudioContext || window.webkitAudioContext)()
    playAcRef.current = ac

    const from      = fromSec !== undefined ? fromSec : seekRef.current
    const startFrom = Math.max(0, Math.min(from, bufferRef.current.duration - 0.01))

    const src = ac.createBufferSource()
    src.buffer = bufferRef.current
    src.connect(ac.destination)
    src.start(0, startFrom)
    src.onended = () => {
      cancelAnimationFrame(rafRef.current)
      setIsPlaying(false); setCurrentSec(0)
      seekRef.current = 0; startWallRef.current = null
      drawComposite(0)
    }

    sourceRef.current    = src
    startWallRef.current = ac.currentTime - startFrom
    seekRef.current      = startFrom
    setIsPlaying(true)
    startRAF()
  }, [startRAF, drawComposite])

  // ── Pause ─────────────────────────────────────────────────────────────────
  const pause = useCallback(() => {
    if (snippetTimerRef.current) { clearTimeout(snippetTimerRef.current); snippetTimerRef.current = null }
    cancelAnimationFrame(rafRef.current)
    seekRef.current = currentSec
    if (sourceRef.current) {
      try { sourceRef.current.onended = null; sourceRef.current.stop() } catch {}
    }
    setIsPlaying(false)
  }, [currentSec])

  // ── Hover — pointer cursor near markers ──────────────────────────────────
  const handleCanvasMouseMove = useCallback((e) => {
    if (!detectedNotes.length) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect      = canvas.getBoundingClientRect()
    const ratio     = (e.clientX - rect.left) / rect.width
    const hoverSec  = ratio * totalSecRef.current
    const hitRadius = 20 / (rect.width / totalSecRef.current)  // 20 CSS px in seconds
    const near      = detectedNotes.some(n => Math.abs(n.time_s - hoverSec) < hitRadius)
    canvas.style.cursor = near ? 'pointer' : (loaded ? 'crosshair' : 'default')
  }, [detectedNotes, loaded])

  // ── Click: seek or play 2-second marker snippet ──────────────────────────
  const handleCanvasClick = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect     = canvas.getBoundingClientRect()
    const ratio    = (e.clientX - rect.left) / rect.width
    const clickSec = ratio * totalSecRef.current
    const hitRadius = 20 / (rect.width / totalSecRef.current)

    let nearest = null, minDist = Infinity
    for (const note of detectedNotes) {
      const dist = Math.abs(note.time_s - clickSec)
      if (dist < hitRadius && dist < minDist) { minDist = dist; nearest = note }
    }

    if (nearest && bufferRef.current) {
      if (snippetTimerRef.current) clearTimeout(snippetTimerRef.current)
      play(Math.max(0, nearest.time_s - 0.3))
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
      if (snippetTimerRef.current) { clearTimeout(snippetTimerRef.current); snippetTimerRef.current = null }
      seekRef.current = clickSec
      setCurrentSec(clickSec)
      if (isPlaying) play(clickSec)
      else drawComposite(clickSec)
    }
  }, [isPlaying, play, drawComposite, detectedNotes])

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current)
    if (snippetTimerRef.current) clearTimeout(snippetTimerRef.current)
    if (sourceRef.current) try { sourceRef.current.stop() } catch {}
    if (playAcRef.current && playAcRef.current.state !== 'closed') {
      try { playAcRef.current.close() } catch {}
    }
  }, [])

  const fmt      = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const canPlay  = loaded && !noAudio
  const hasNotes = detectedNotes.length > 0
  const errNotes = detectedNotes.filter(n => noteSeverity(n.cents) === 'off')

  return (
    <div className="ptl-wrap">

      {/* DPR-aware canvas container */}
      <div
        ref={containerRef}
        className="ptl-canvas-container"
        style={{ position: 'relative', width: '100%' }}
      >
        <canvas
          ref={canvasRef}
          width={physW}
          height={physH}
          className="ptl-canvas"
          onClick={canPlay || hasNotes ? handleCanvasClick : undefined}
          onMouseMove={hasNotes ? handleCanvasMouseMove : undefined}
          style={{ width: '100%', height: H, display: 'block', cursor: canPlay ? 'crosshair' : 'default' }}
        />
        {noAudio && hasNotes && (
          <div className="ptl-no-audio-banner">📭 Audio not stored · saved analysis</div>
        )}
        {noAudio && !hasNotes && (
          <div className="ptl-no-data">No recording data available.</div>
        )}
        {decoding && <div className="ptl-loading">Decoding…</div>}
        {decodeError && <div className="ptl-loading" style={{ color: 'var(--red)' }}>Audio decode failed</div>}
        {hasNotes && canPlay && !decoding && (
          <div style={{
            position: 'absolute', bottom: 4, right: 8,
            fontSize: '0.68rem', color: 'rgba(245,166,35,0.45)',
            pointerEvents: 'none', userSelect: 'none',
          }}>
            {errNotes.length > 0
              ? `${errNotes.length} mistake${errNotes.length > 1 ? 's' : ''} — click to hear`
              : 'Click to seek'}
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
