"""Aubio-based note detection pipeline.

Replaces the separate onset + pitch passes with aubio's native algorithms:
  - aubio.onset    — energy/spectral onset detection
  - aubio.pitch    - YIN pitch estimation

For each onset the pitch is taken as the median of stable frames in the
20–300 ms sustain window after the transient, which avoids the noisy
attack peak that causes double-detection in single-pass schemes.

Public API
----------
detect_notes_aubio(signal, sr, bpm, scale_notes=None, a4=440.0, config=None)
  -> list[dict]:  each dict has the keys:
        start_ms, duration_ms, pitch_hz, note_name, confidence,
        time_s, freq_hz, note, cents, beat_offset_ms, beat_time_s, timing
"""

from __future__ import annotations

import math
import numpy as np
from typing import Optional

# ── Constants ──────────────────────────────────────────────────────────────────
GUITAR_MIN_HZ    = 75.0   # E2 with margin
GUITAR_MAX_HZ    = 1400.0 # e5 with margin
ONSET_WIN_SIZE   = 512    # aubio onset hop/win (samples) — ~12ms at 44100
PITCH_WIN_SIZE   = 2048   # aubio pitch frame size — ~46ms at 44100
PITCH_HOP_SIZE   = 512    # pitch hop
MIN_ONSET_GAP_MS = 150    # ignore onsets closer than this
PITCH_WIN_MIN_MS = 20     # earliest sustain frame after onset
PITCH_WIN_MAX_MS = 300    # latest sustain frame after onset
NOTE_NAMES       = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


# ── Helpers ───────────────────────────────────────────────────────────────────

def _freq_to_note(freq_hz: float, a4: float = 440.0) -> tuple[str, int, float, str]:
    """Return (note_name, octave, cents, note_string) for a given frequency."""
    if freq_hz <= 0:
        return ('?', 0, 0.0, '?')
    semitones = 12.0 * math.log2(freq_hz / a4)
    midi      = round(semitones) + 69
    cents     = (semitones - (midi - 69)) * 100.0
    octave    = (midi // 12) - 1
    name      = NOTE_NAMES[midi % 12]
    return (name, octave, round(cents, 1), f'{name}{octave}')


def _scale_correctness(note_name: str, scale_notes: Optional[list[str]]) -> str:
    """Classify note as 'correct', 'close', or 'wrong' relative to a scale.

    'close' = one semitone away from a scale note.
    If scale_notes is None/empty, returns 'correct' (no scale context).
    """
    if not scale_notes:
        return 'correct'
    if note_name in scale_notes:
        return 'correct'

    # Check one semitone away
    all_notes = NOTE_NAMES
    idx = all_notes.index(note_name) if note_name in all_notes else -1
    if idx >= 0:
        neighbour_below = all_notes[(idx - 1) % 12]
        neighbour_above = all_notes[(idx + 1) % 12]
        if neighbour_below in scale_notes or neighbour_above in scale_notes:
            return 'close'
    return 'wrong'


def _find_beat_phase(onset_times_s: list[float], beat_sec: float) -> float:
    """200-candidate brute-force beat phase alignment (same as frontend)."""
    if not onset_times_s or beat_sec <= 0:
        return 0.0
    best_phase, best_err = 0.0, float('inf')
    for i in range(200):
        candidate = (i / 200) * beat_sec
        err = sum(
            min(
                ((t - candidate) % beat_sec + beat_sec) % beat_sec,
                beat_sec - ((t - candidate) % beat_sec + beat_sec) % beat_sec
            )
            for t in onset_times_s
        )
        if err < best_err:
            best_err, best_phase = err, candidate
    return best_phase


def _signed_beat_offset_ms(time_s: float, beat_sec: float, phase_s: float) -> float:
    """Signed ms offset from nearest beat (negative = early, positive = late)."""
    if beat_sec <= 0:
        return 0.0
    pos    = ((time_s - phase_s) % beat_sec + beat_sec) % beat_sec
    signed = pos - beat_sec if pos > beat_sec / 2 else pos
    return round(signed * 1000, 1)


def _timing_label(offset_ms: float) -> str:
    a = abs(offset_ms)
    if a < 20:   return 'on'
    if a < 60:   return 'close'
    return 'early' if offset_ms < 0 else 'late'


# ── Main pipeline ─────────────────────────────────────────────────────────────

def detect_notes_aubio(
    signal:      np.ndarray,
    sr:          int,
    bpm:         float = 120.0,
    scale_notes: Optional[list[str]] = None,
    a4:          float = 440.0,
    latency_ms:  float = 0.0,
) -> list[dict]:
    """Detect notes in a mono float32 audio signal using aubio.

    Parameters
    ----------
    signal      : mono float32 ndarray
    sr          : sample rate (Hz)
    bpm         : tempo for beat-grid alignment
    scale_notes : list of note names in the scale (e.g. ['C','D','E','F','G','A','B'])
                  or None to skip scale correctness check
    a4          : A4 tuning reference (Hz)
    latency_ms  : system latency correction (ms) — subtracted from onset times

    Returns
    -------
    List of note dicts, one per detected note, sorted by time_s.
    """
    try:
        import aubio
    except ImportError:
        raise RuntimeError(
            "aubio is not installed. Run: pip install aubio"
        )

    signal = np.asarray(signal, dtype=np.float32)
    if signal.ndim > 1:
        signal = signal[:, 0]

    # ── Pass 1: collect pitch frames with aubio.pitch ─────────────────────
    pitch_detector = aubio.pitch(
        'yin',
        PITCH_WIN_SIZE,
        PITCH_HOP_SIZE,
        sr,
    )
    pitch_detector.set_unit('Hz')
    pitch_detector.set_tolerance(0.8)

    pitch_frames: list[tuple[float, float, float]] = []  # (time_ms, freq_hz, confidence)
    n_hops = (len(signal) - PITCH_WIN_SIZE) // PITCH_HOP_SIZE + 1

    for hop in range(n_hops):
        start = hop * PITCH_HOP_SIZE
        end   = start + PITCH_WIN_SIZE
        frame = signal[start:end]
        if len(frame) < PITCH_WIN_SIZE:
            frame = np.pad(frame, (0, PITCH_WIN_SIZE - len(frame)))

        freq       = float(pitch_detector(frame)[0])
        confidence = float(pitch_detector.get_confidence())
        time_ms    = (start / sr) * 1000.0
        pitch_frames.append((time_ms, freq, confidence))

    # ── Pass 2: onset detection with aubio.onset ──────────────────────────
    onset_detector = aubio.onset(
        'default',   # hfc + spectral flux combination
        ONSET_WIN_SIZE * 4,
        ONSET_WIN_SIZE,
        sr,
    )
    onset_detector.set_threshold(0.3)
    onset_detector.set_minioi_ms(MIN_ONSET_GAP_MS)

    onset_times_ms: list[float] = []
    n_onset_hops = (len(signal) - ONSET_WIN_SIZE) // ONSET_WIN_SIZE + 1

    for hop in range(n_onset_hops):
        start = hop * ONSET_WIN_SIZE
        frame = signal[start:start + ONSET_WIN_SIZE]
        if len(frame) < ONSET_WIN_SIZE:
            frame = np.pad(frame, (0, ONSET_WIN_SIZE - len(frame)))

        if onset_detector(frame):
            onset_ms = float(onset_detector.get_last_ms())
            if onset_ms > 0:
                onset_times_ms.append(onset_ms)

    # ── Pass 3: match sustained pitch to each onset ───────────────────────
    # For each onset, take the median of YIN pitch readings from the
    # 20–300 ms window after the onset (sustain phase, not the attack).
    latency_s   = latency_ms / 1000.0
    beat_sec    = 60.0 / bpm if bpm > 0 else 0.5
    raw_notes: list[dict] = []

    for onset_ms in onset_times_ms:
        window = [
            freq for (t_ms, freq, conf) in pitch_frames
            if onset_ms + PITCH_WIN_MIN_MS <= t_ms <= onset_ms + PITCH_WIN_MAX_MS
            and GUITAR_MIN_HZ <= freq <= GUITAR_MAX_HZ
            and conf > 0.5
        ]
        if not window:
            # Fallback: search a wider window with lower confidence bar
            window = [
                freq for (t_ms, freq, conf) in pitch_frames
                if onset_ms <= t_ms <= onset_ms + PITCH_WIN_MAX_MS + 200
                and GUITAR_MIN_HZ <= freq <= GUITAR_MAX_HZ
                and conf > 0.3
            ]

        if not window:
            continue   # onset with no identifiable pitch — skip

        freq_hz = float(np.median(window))
        if not (GUITAR_MIN_HZ <= freq_hz <= GUITAR_MAX_HZ):
            continue

        confidence = float(np.mean([
            conf for (t_ms, freq, conf) in pitch_frames
            if onset_ms + PITCH_WIN_MIN_MS <= t_ms <= onset_ms + PITCH_WIN_MAX_MS
            and GUITAR_MIN_HZ <= freq <= GUITAR_MAX_HZ
        ]) if any(
            onset_ms + PITCH_WIN_MIN_MS <= t_ms <= onset_ms + PITCH_WIN_MAX_MS
            for (t_ms, _, _) in pitch_frames
        ) else 0.7)

        note_name, octave, cents, note_str = _freq_to_note(freq_hz, a4)
        time_s = round(onset_ms / 1000.0 - latency_s, 3)
        time_s = max(0.0, time_s)

        raw_notes.append({
            'time_s':    time_s,
            'freq_hz':   round(freq_hz, 2),
            'note':      note_str,
            'note_name': note_name,
            'cents':     cents,
            'confidence': round(min(1.0, max(0.0, confidence)), 3),
            'start_ms':  round(onset_ms, 1),
        })

    # Sort by time
    raw_notes.sort(key=lambda n: n['time_s'])

    # ── Beat alignment ────────────────────────────────────────────────────
    onset_times_s = [n['time_s'] for n in raw_notes]
    phase_s       = _find_beat_phase(onset_times_s, beat_sec)

    # ── Estimate note durations (onset-to-next-onset, capped at 2s) ───────
    for i, note in enumerate(raw_notes):
        next_onset_s = raw_notes[i + 1]['time_s'] if i + 1 < len(raw_notes) else note['time_s'] + 0.5
        duration_s   = min(next_onset_s - note['time_s'], 2.0)
        note['duration_ms'] = round(duration_s * 1000, 1)
        note['start_ms']    = round(note['time_s'] * 1000, 1)

    # ── Annotate timing + scale correctness ──────────────────────────────
    for note in raw_notes:
        offset_ms      = _signed_beat_offset_ms(note['time_s'], beat_sec, phase_s)
        note_name, _, octave_str = note['note_name'], note['note'], note['cents']

        # Nearest beat time
        pos             = ((note['time_s'] - phase_s) % beat_sec + beat_sec) % beat_sec
        nearest_off     = pos - beat_sec if pos > beat_sec / 2 else pos
        beat_time_s     = round(note['time_s'] - nearest_off, 3)

        note['beat_offset_ms']  = offset_ms
        note['beat_time_s']     = beat_time_s
        note['timing']          = _timing_label(offset_ms)
        note['pitch_hz']        = note['freq_hz']   # alias for spec compatibility
        note['scale_status']    = _scale_correctness(note['note_name'], scale_notes)

    return raw_notes
