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

// ── Beat-timing helpers ───────────────────────────────────────────────────────

/**
 * Auto-detect grid phase by minimising total |note − nearest_beat|.
 * Returns phase in seconds (offset of beat 0 from t=0).
 */
function findBeatPhase(notes, beatSec) {
  if (!notes.length || beatSec <= 0) return 0
  const times = notes.map(n => n.time_s)
  let bestPhase = 0, bestErr = Infinity
  for (let i = 0; i < 200; i++) {
    const candidate = (i / 200) * beatSec
    let err = 0
    for (const t of times) {
      const pos = ((t - candidate) % beatSec + beatSec) % beatSec
      err += Math.min(pos, beatSec - pos)
    }
    if (err < bestErr) { bestErr = err; bestPhase = candidate }
  }
  return bestPhase
}

/**
 * Signed beat offset in ms (negative = early, positive = late).
 * Uses backend-supplied beat_offset_ms when available (includes latency correction).
 */
function beatOffsetMs(timeS, beatSec, phaseS) {
  if (beatSec <= 0) return 0
  const pos = ((timeS - phaseS) % beatSec + beatSec) % beatSec
  const signed = pos > beatSec / 2 ? pos - beatSec : pos
  return signed * 1000
}

/**
 * Timing severity bucket.
 * 'unknown' = onset with no pitch detection (freq_hz === 0).
 */
function timingSeverity(offsetMs) {
  const a = Math.abs(offsetMs)
  if (a < 20) return 'good'
  if (a < 60) return 'close'
  return 'off'
}

/**
 * From a merged note list, return only the notes worth displaying:
 *   – timing error > 20 ms (close or off)  ← player is noticeably off-beat
 *   – pitch unknown (freq_hz === 0)         ← something played, can't tell what
 * Cap at MAX_MARKERS sorted worst-first, then re-sort by time for rendering.
 */
const MAX_MARKERS = 12
function computeVisibleNotes(notes, beatSec, phaseS) {
  const sevOf = (n) => {
    if (n.freq_hz === 0) return 'unknown'
    const oMs = n.beat_offset_ms ?? beatOffsetMs(n.time_s, beatSec, phaseS)
    return timingSeverity(oMs)
  }
  const sevOrder = { off: 2, close: 1, unknown: 0, good: -1 }
  const problematic = notes.filter(n => sevOf(n) !== 'good')
  return problematic
    .sort((a, b) => (sevOrder[sevOf(b)] ?? 0) - (sevOrder[sevOf(a)] ?? 0))
    .slice(0, MAX_MARKERS)
    .sort((a, b) => a.time_s - b.time_s)
}

const H = 110   // logical canvas height (CSS pixels)

const C = {
  bg:       '#0b0907',
  good:     '#22c55e',   // on-time   < 20 ms
  close:    '#eab308',   // close     20-60 ms
  off:      '#ef4444',   // late/early >= 60 ms
  unknown:  '#6b7280',   // onset detected, pitch unknown
  beat:     '#F5A623',   // beat grid + playhead
  playhead: '#F5A623',
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
 * Build static layer: background → waveform → beat grid → note markers.
 *
 * Note markers are now coloured by TIMING offset from the nearest beat
 * (not pitch accuracy). Each note stays at its real time_s — never snapped.
 *
 * Beat grid shows:
 *   – small downward triangle at the top of every beat  ← "you should play here"
 *   – tick at the bottom of every beat
 *   – faint full-height bar line on every 4th beat (measure)
 *
 * phaseS (seconds): grid phase pre-computed in the component so it is
 * consistent between buildOffscreen and the component-level errNotes count.
 */
function buildOffscreen(physW, physH, totalSec, audioBuffer, bpm, detectedNotes, dpr, phaseS) {
  const off = document.createElement('canvas')
  off.width  = physW
  off.height = physH
  const oc   = off.getContext('2d')

  // Scale once — draw everything in logical (CSS-pixel) coords
  oc.scale(dpr, dpr)
  const lW       = physW / dpr
  const lH       = physH / dpr
  const midY     = lH / 2
  const pxPerSec = lW / totalSec

  // Background
  oc.fillStyle = C.bg
  oc.fillRect(0, 0, lW, lH)

  // ── Waveform — dim, so timing markers stay visually dominant ──────────────
  if (audioBuffer) {
    const rms  = buildRMS(audioBuffer.getChannelData(0), Math.round(lW))
    const grad = oc.createLinearGradient(0, 0, 0, lH)
    grad.addColorStop(0,   'rgba(245,166,35,0.10)')
    grad.addColorStop(0.5, 'rgba(245,166,35,0.18)')
    grad.addColorStop(1,   'rgba(245,166,35,0.10)')
    oc.fillStyle = grad
    oc.beginPath()
    oc.moveTo(0, midY)
    for (let x = 0; x < Math.round(lW); x++) oc.lineTo(x, midY - rms[x] * midY * 0.55)
    for (let x = Math.round(lW) - 1; x >= 0; x--) oc.lineTo(x, midY + rms[x] * midY * 0.55)
    oc.closePath()
    oc.fill()
  }

  // ── Beat grid ─────────────────────────────────────────────────────────────
  // Every beat: small triangle target marker at top + bottom tick.
  // Every 4th beat: faint full-height bar line.
  const beatSec  = bpm > 0 ? 60 / bpm : 0.5
  const numBeats = Math.ceil(totalSec / beatSec) + 2

  for (let i = -1; i <= numBeats; i++) {
    const x = (phaseS + i * beatSec) * pxPerSec
    if (x < -4 || x > lW + 4) continue
    const isMeasure = (i % 4 === 0)

    if (isMeasure) {
      // Bar line — very faint, full height
      oc.globalAlpha = 0.16
      oc.strokeStyle = C.beat
      oc.lineWidth   = 0.75
      oc.beginPath(); oc.moveTo(x, 0); oc.lineTo(x, lH); oc.stroke()
    }

    // Bottom tick
    oc.globalAlpha = isMeasure ? 0.35 : 0.22
    oc.strokeStyle = C.beat
    oc.lineWidth   = 0.75
    oc.beginPath(); oc.moveTo(x, lH - 9); oc.lineTo(x, lH); oc.stroke()

    // Downward triangle at top — "play here" target
    oc.globalAlpha = isMeasure ? 0.50 : 0.28
    oc.fillStyle   = C.beat
    oc.beginPath()
    oc.moveTo(x - 3.5, 0)
    oc.lineTo(x + 3.5, 0)
    oc.lineTo(x, 6.5)
    oc.closePath()
    oc.fill()

    oc.globalAlpha = 1
  }

  // ── Note markers — coloured by timing offset from nearest beat ────────────
  // Back-supplied beat_offset_ms is used when available (has latency correction).
  // Frontend fallback: compute from time_s, beatSec, phaseS.
  const noteSev = (note) => {
    if (note.freq_hz === 0) return 'unknown'
    const oMs = note.beat_offset_ms ?? beatOffsetMs(note.time_s, beatSec, phaseS)
    return timingSeverity(oMs)
  }

  // Draw in ascending severity order so errors render on top
  const sorted = [...detectedNotes].sort((a, b) => {
    const order = { good: 0, unknown: 1, close: 2, off: 3 }
    return order[noteSev(a)] - order[noteSev(b)]
  })

  sorted.forEach(note => {
    const x   = note.time_s * pxPerSec
    const sev = noteSev(note)
    const col = C[sev]

    if (sev === 'off') {
      // Late/early — dominant glow + stem
      oc.globalAlpha = 0.22; oc.fillStyle = col
      oc.beginPath(); oc.arc(x, midY, 18, 0, Math.PI * 2); oc.fill()
      oc.globalAlpha = 0.55; oc.strokeStyle = col; oc.lineWidth = 1.5
      oc.beginPath(); oc.moveTo(x, 8); oc.lineTo(x, lH - 10); oc.stroke()
      oc.globalAlpha = 1; oc.fillStyle = col; oc.shadowColor = col; oc.shadowBlur = 12
      oc.beginPath(); oc.arc(x, 12, 6, 0, Math.PI * 2); oc.fill()
      oc.shadowBlur = 0
    } else if (sev === 'close') {
      // Within 20-60 ms
      oc.globalAlpha = 0.12; oc.fillStyle = col
      oc.beginPath(); oc.arc(x, midY, 8, 0, Math.PI * 2); oc.fill()
      oc.globalAlpha = 0.80; oc.fillStyle = col; oc.shadowColor = col; oc.shadowBlur = 4
      oc.beginPath(); oc.arc(x, 12, 4, 0, Math.PI * 2); oc.fill()
      oc.shadowBlur = 0
    } else if (sev === 'unknown') {
      // No pitch — small gray dot, no glow
      oc.globalAlpha = 0.50; oc.fillStyle = col
      oc.beginPath(); oc.arc(x, 12, 3.5, 0, Math.PI * 2); oc.fill()
    } else {
      // On-time (< 20 ms)
      oc.globalAlpha = 0.60; oc.fillStyle = col; oc.shadowColor = col; oc.shadowBlur = 4
      oc.beginPath(); oc.arc(x, 12, 4, 0, Math.PI * 2); oc.fill()
      oc.shadowBlur = 0
    }
    oc.globalAlpha = 1
  })

  return off
}

// ─────────────────────────────────────────────────────────────────────────────
export default function PlaybackTimeline({ audioUrl, bpm = 120, detectedNotes = [], durationSec = 10 }) {
  const containerRef      = useRef(null)   // wrapping div — observed for width
  const canvasRef         = useRef(null)
  const offscreenRef      = useRef(null)
  const highlightedNoteRef = useRef(null)  // note currently highlighted after a click
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

  // Beat grid phase — auto-aligned to the notes, stable across renders
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const beatSec = bpm > 0 ? 60 / bpm : 0.5
  const phaseS  = detectedNotes.length ? findBeatPhase(detectedNotes, beatSec) : 0

  // Merge closely-spaced ghost onsets, then filter to only problem notes (≤20ms off)
  const visibleNotes = computeVisibleNotes(detectedNotes, beatSec, phaseS)

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

    console.debug('[PlaybackTimeline] Fetching audio:', audioUrl)
    ;(async () => {
      let tmpAc = null
      try {
        const res = await fetch(audioUrl)
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${audioUrl}`)
        const raw = await res.arrayBuffer()
        if (cancelled) return
        console.debug('[PlaybackTimeline] Fetched', raw.byteLength, 'bytes, decoding…')

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
        if (tmpAc) { try { tmpAc.close() } catch {} }
        if (!cancelled) {
          // 404 = audio file not on disk any more — show friendly banner, not error
          if (e.message && e.message.includes('HTTP 404')) setNoAudio(true)
          else setDecodeError(true)
        }
        console.warn('[PlaybackTimeline] decode failed:', e.message)
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
      bpm, visibleNotes, dpr, phaseS
    )
    drawComposite(seekRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, totalSec, bpm, visibleNotes, physW, physH, phaseS])

  // ── Composite: blit static offscreen + playhead + highlight ring ──────────
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

    const d  = window.devicePixelRatio || 1
    const lW = cW / d
    const lH = cH / d

    // ── Highlight ring around last-clicked note ───────────────────────────
    const hn = highlightedNoteRef.current
    if (hn) {
      const hx = (hn.time_s / totalSecRef.current) * lW
      ctx.save()
      ctx.scale(d, d)
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'
      ctx.lineWidth   = 1.5
      ctx.shadowColor = '#ffffff'
      ctx.shadowBlur  = 8
      ctx.beginPath()
      ctx.arc(hx, 12, 11, 0, Math.PI * 2)
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.restore()
    }

    if (posSec <= 0) return

    // Draw playhead in logical (CSS-pixel) coordinates
    const x = Math.min((posSec / totalSecRef.current) * lW, lW - 1)

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

  // ── Hover — pointer cursor near visible markers ────────────────────────
  const handleCanvasMouseMove = useCallback((e) => {
    if (!visibleNotes.length) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect      = canvas.getBoundingClientRect()
    const ratio     = (e.clientX - rect.left) / rect.width
    const hoverSec  = ratio * totalSecRef.current
    const hitRadius = 20 / (rect.width / totalSecRef.current)  // 20 CSS px in seconds
    const near      = visibleNotes.some(n => Math.abs(n.time_s - hoverSec) < hitRadius)
    canvas.style.cursor = near ? 'pointer' : (loaded ? 'crosshair' : 'default')
  }, [visibleNotes, loaded])

  // ── Click: seek or play 2-second marker snippet + highlight the note ────────
  const handleCanvasClick = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect     = canvas.getBoundingClientRect()
    const ratio    = (e.clientX - rect.left) / rect.width
    const clickSec = ratio * totalSecRef.current
    const hitRadius = 20 / (rect.width / totalSecRef.current)

    let nearest = null, minDist = Infinity
    for (const note of visibleNotes) {
      const dist = Math.abs(note.time_s - clickSec)
      if (dist < hitRadius && dist < minDist) { minDist = dist; nearest = note }
    }

    if (nearest && bufferRef.current) {
      if (snippetTimerRef.current) clearTimeout(snippetTimerRef.current)
      highlightedNoteRef.current = nearest
      play(Math.max(0, nearest.time_s - 0.3))
      snippetTimerRef.current = setTimeout(() => {
        snippetTimerRef.current = null
        highlightedNoteRef.current = null
        cancelAnimationFrame(rafRef.current)
        if (sourceRef.current) { try { sourceRef.current.onended = null; sourceRef.current.stop() } catch {} }
        setIsPlaying(false)
        seekRef.current = nearest.time_s
        setCurrentSec(nearest.time_s)
        drawComposite(nearest.time_s)
      }, 2000)
    } else {
      if (snippetTimerRef.current) { clearTimeout(snippetTimerRef.current); snippetTimerRef.current = null }
      highlightedNoteRef.current = null
      seekRef.current = clickSec
      setCurrentSec(clickSec)
      if (isPlaying) play(clickSec)
      else drawComposite(clickSec)
    }
  }, [isPlaying, play, drawComposite, visibleNotes])

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
  const hasNotes = visibleNotes.length > 0
  // errNotes = notes shown that are badly timed (>= 60 ms off the beat)
  const errNotes = visibleNotes.filter(n => {
    if (n.freq_hz === 0) return false
    const oMs = n.beat_offset_ms ?? beatOffsetMs(n.time_s, beatSec, phaseS)
    return timingSeverity(oMs) === 'off'
  })

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
              ? `${errNotes.length} late/early — click to hear`
              : 'Click to seek'}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="ptl-controls" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
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
            <span className="ptl-legend-item"><span className="ptl-dot ptl-dot--g" />On time</span>
            <span className="ptl-legend-item"><span className="ptl-dot ptl-dot--y" />±20-60ms</span>
            <span className="ptl-legend-item"><span className="ptl-dot ptl-dot--r" />Early/Late</span>
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="ptl-bpm-label">
        {bpm} BPM
        {hasNotes && ` · ${visibleNotes.length} of ${detectedNotes.length} notes`}
        {!canPlay && !noAudio && !decoding && !loaded && ' · loading…'}
      </div>
    </div>
  )
}
