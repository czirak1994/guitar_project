/**
 * PlaybackTimeline — canvas-based waveform + note overlay + live playhead
 *
 * Props:
 *   audioUrl      – blob URL of the recording (null = static/no-audio mode)
 *   bpm           – tempo in BPM for beat grid
 *   detectedNotes – [{ time_s, note, freq_hz, cents }] from /api/analyze
 *   durationSec   – total recording length in seconds
 */
import { useRef, useEffect, useState, useCallback } from 'react'

const CANVAS_H = 100
const COLORS = {
  bg:         '#0b0907',
  waveform:   'rgba(245, 166, 35, 0.3)',
  beatMinor:  'rgba(245, 166, 35, 0.10)',
  beatMajor:  'rgba(245, 166, 35, 0.28)',
  beatLabel:  'rgba(245, 166, 35, 0.45)',
  good:       '#22c55e',
  close:      '#eab308',
  off:        '#ef4444',
  playhead:   '#F5A623',
}

function noteColor(cents) {
  const abs = Math.abs(cents ?? 50)
  if (abs < 18) return COLORS.good
  if (abs < 38) return COLORS.close
  return COLORS.off
}

export default function PlaybackTimeline({ audioUrl, bpm = 120, detectedNotes = [], durationSec = 10 }) {
  const canvasRef   = useRef(null)
  const offscreenRef = useRef(null)   // pre-rendered static layer
  const ctxRef      = useRef(null)    // AudioContext
  const sourceRef   = useRef(null)    // current AudioBufferSourceNode
  const bufferRef   = useRef(null)    // decoded AudioBuffer
  const rafRef      = useRef(null)
  const startWallRef = useRef(null)   // audioCtx.currentTime when play() was called
  const seekRef      = useRef(0)      // seconds we started from

  const [isPlaying,   setIsPlaying]   = useState(false)
  const [currentSec,  setCurrentSec]  = useState(0)
  const [totalSec,    setTotalSec]    = useState(durationSec || 10)
  const [loaded,      setLoaded]      = useState(false)
  const [decoding,    setDecoding]    = useState(false)
  const [noAudio,     setNoAudio]     = useState(!audioUrl)

  // ── Decode audio once ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!audioUrl) { setNoAudio(true); return }
    setNoAudio(false)
    setDecoding(true)
    let cancelled = false

    ;(async () => {
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)()
        const res = await fetch(audioUrl)
        const raw = await res.arrayBuffer()
        const buf = await ac.decodeAudioData(raw)
        if (cancelled) { ac.close(); return }
        bufferRef.current = buf
        ctxRef.current    = ac
        setTotalSec(buf.duration)
        setLoaded(true)
      } catch { /* blob expired or codec error — show static markers */ }
      if (!cancelled) setDecoding(false)
    })()

    return () => { cancelled = true }
  }, [audioUrl])

  // ── Build offscreen (static) layer whenever inputs change ────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const W = canvas.width
    const H = CANVAS_H

    // Create / reuse offscreen canvas
    if (!offscreenRef.current) {
      offscreenRef.current = document.createElement('canvas')
    }
    const off = offscreenRef.current
    off.width  = W
    off.height = H
    const oc = off.getContext('2d')

    oc.clearRect(0, 0, W, H)

    // Background
    oc.fillStyle = COLORS.bg
    oc.fillRect(0, 0, W, H)

    const pxPerSec = W / totalSec

    // Waveform
    if (loaded && bufferRef.current) {
      const data = bufferRef.current.getChannelData(0)
      const step = Math.max(1, Math.ceil(data.length / W))
      const midY = H / 2

      oc.strokeStyle = COLORS.waveform
      oc.lineWidth   = 1
      oc.beginPath()
      for (let x = 0; x < W; x++) {
        let mn = 0, mx = 0
        for (let j = 0; j < step; j++) {
          const v = data[x * step + j] || 0
          if (v < mn) mn = v
          if (v > mx) mx = v
        }
        const y1 = midY + mn * midY * 0.9
        const y2 = midY + mx * midY * 0.9
        oc.moveTo(x, y1)
        oc.lineTo(x, y2)
      }
      oc.stroke()
    }

    // Beat grid
    const beatSec = 60 / bpm
    const numBeats = Math.ceil(totalSec / beatSec) + 1
    oc.font = '9px JetBrains Mono, monospace'
    for (let i = 0; i <= numBeats; i++) {
      const x = i * beatSec * pxPerSec
      if (x > W) break
      const isMeasure = i % 4 === 0
      oc.strokeStyle = isMeasure ? COLORS.beatMajor : COLORS.beatMinor
      oc.lineWidth   = isMeasure ? 1.2 : 0.7
      oc.beginPath()
      oc.moveTo(x, 0)
      oc.lineTo(x, H)
      oc.stroke()
      if (isMeasure && i > 0) {
        oc.fillStyle = COLORS.beatLabel
        oc.fillText(`${i / 4 + 1}`, x + 3, 11)
      }
    }

    // Note markers
    detectedNotes.forEach(note => {
      const x  = note.time_s * pxPerSec
      const col = noteColor(note.cents)

      // Stem
      oc.globalAlpha  = 0.75
      oc.strokeStyle  = col
      oc.lineWidth    = 1.5
      oc.beginPath()
      oc.moveTo(x, H * 0.18)
      oc.lineTo(x, H * 0.82)
      oc.stroke()

      // Dot
      oc.globalAlpha = 1
      oc.fillStyle   = col
      oc.beginPath()
      oc.arc(x, H * 0.18, 4, 0, Math.PI * 2)
      oc.fill()

      // Note label
      if (note.note) {
        oc.fillStyle    = col
        oc.globalAlpha  = 0.9
        oc.font         = 'bold 8px JetBrains Mono, monospace'
        const labelX = Math.max(2, Math.min(x - 5, W - 22))
        oc.fillText(note.note, labelX, H * 0.18 - 6)
        oc.globalAlpha  = 1
        oc.font         = '9px JetBrains Mono, monospace'
      }
    })

    // Trigger composite redraw
    drawComposite(currentSec)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, totalSec, bpm, detectedNotes])

  // ── Composite draw: offscreen + playhead ─────────────────────────────────────
  const drawComposite = useCallback((posSec) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W   = canvas.width
    const H   = CANVAS_H

    // Draw static layer
    if (offscreenRef.current) {
      ctx.drawImage(offscreenRef.current, 0, 0)
    } else {
      ctx.fillStyle = COLORS.bg
      ctx.fillRect(0, 0, W, H)
    }

    // Playhead
    const x = (posSec / totalSec) * W
    if (posSec > 0) {
      // Tint past region
      ctx.fillStyle = 'rgba(245, 166, 35, 0.05)'
      ctx.fillRect(0, 0, x, H)

      // Glow
      const g = ctx.createLinearGradient(x - 6, 0, x + 6, 0)
      g.addColorStop(0, 'rgba(245,166,35,0)')
      g.addColorStop(0.5, 'rgba(245,166,35,0.4)')
      g.addColorStop(1, 'rgba(245,166,35,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - 6, 0, 12, H)

      // Line
      ctx.strokeStyle = COLORS.playhead
      ctx.lineWidth   = 2
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
      ctx.stroke()

      // Triangle cap
      ctx.fillStyle = COLORS.playhead
      ctx.beginPath()
      ctx.moveTo(x - 5, 0)
      ctx.lineTo(x + 5, 0)
      ctx.lineTo(x, 7)
      ctx.closePath()
      ctx.fill()
    }
  }, [totalSec])

  // Redraw when seek position changes (not playing)
  useEffect(() => {
    if (!isPlaying) drawComposite(currentSec)
  }, [currentSec, isPlaying, drawComposite])

  // ── RAF loop ─────────────────────────────────────────────────────────────────
  const startRAF = useCallback(() => {
    function tick() {
      if (!ctxRef.current || startWallRef.current === null) return
      const elapsed = ctxRef.current.currentTime - startWallRef.current
      const pos = Math.min(elapsed, totalSec)
      setCurrentSec(pos)
      drawComposite(pos)
      if (pos < totalSec) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        setIsPlaying(false)
        setCurrentSec(0)
        seekRef.current = 0
        startWallRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [totalSec, drawComposite])

  // ── Play / Pause ──────────────────────────────────────────────────────────────
  const play = useCallback(async (fromSec) => {
    if (!bufferRef.current) return
    from = fromSec ?? seekRef.current

    let ac = ctxRef.current
    if (!ac || ac.state === 'closed') {
      ac = new (window.AudioContext || window.webkitAudioContext)()
      ctxRef.current = ac
    }
    if (ac.state === 'suspended') await ac.resume()

    // Stop previous source
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
      seekRef.current = 0
      startWallRef.current = null
    }

    sourceRef.current  = src
    startWallRef.current = ac.currentTime - startFrom
    seekRef.current    = startFrom

    setIsPlaying(true)
    startRAF()
  }, [startRAF])

  const pause = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    seekRef.current = currentSec
    if (sourceRef.current) {
      try { sourceRef.current.onended = null; sourceRef.current.stop() } catch {}
    }
    setIsPlaying(false)
  }, [currentSec])

  // ── Canvas click → seek ───────────────────────────────────────────────────────
  const handleCanvasClick = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    const seekSec = ratio * totalSec
    seekRef.current = seekSec
    setCurrentSec(seekSec)
    if (isPlaying) play(seekSec)
    else drawComposite(seekSec)
  }, [totalSec, isPlaying, play, drawComposite])

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current)
    if (sourceRef.current) try { sourceRef.current.stop() } catch {}
  }, [])

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  const canPlay = loaded && !noAudio
  const hasNotes = detectedNotes.length > 0

  return (
    <div className="ptl-wrap">

      {/* Canvas */}
      <div className="ptl-canvas-container">
        <canvas
          ref={canvasRef}
          width={560}
          height={CANVAS_H}
          className="ptl-canvas"
          onClick={canPlay ? handleCanvasClick : undefined}
          style={{ cursor: canPlay ? 'crosshair' : 'default' }}
        />
        {noAudio && !hasNotes && (
          <div className="ptl-no-data">No audio or note data available.</div>
        )}
        {noAudio && hasNotes && (
          <div className="ptl-no-audio-banner">
            📭 Audio not stored · showing saved analysis
          </div>
        )}
        {decoding && (
          <div className="ptl-loading">Decoding audio…</div>
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
            <span className="ptl-seek-hint">Click timeline to seek</span>
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

      {/* Beat label row */}
      {bpm && (
        <div className="ptl-bpm-label">
          {bpm} BPM · {hasNotes ? `${detectedNotes.length} notes detected` : 'No notes detected'}
        </div>
      )}
    </div>
  )
}
