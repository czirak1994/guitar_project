"""Librosa-based note detection pipeline.

Algorithm
---------
1. Onset detection  — librosa.onset.onset_detect (spectral flux, backtracked)
2. Pitch estimation — librosa.pyin (probabilistic YIN, voiced frames only)
3. Per-onset pitch  — median of pyin voiced frames in the 20–300 ms sustain
                      window after each onset (avoids noisy attack transient)
4. Beat alignment   — 200-candidate brute-force phase search (same as frontend)
5. Scale correctness— 'correct' / 'close' / 'wrong' vs optional scale_notes list

Public API
----------
detect_notes(signal, sr, bpm=120.0, scale_notes=None, a4=440.0, latency_ms=0.0)
    -> list[dict]

Each dict contains:
    start_ms        — onset time in ms (latency-corrected)
    duration_ms     — estimated duration (onset-to-next-onset, max 2 s)
    pitch_hz        — median pitch in sustain window (Hz)
    note_name       — e.g. 'A', 'C#'
    confidence      — mean pyin confidence in sustain window (0–1)
    time_s          — onset time in seconds (latency-corrected)
    freq_hz         — alias for pitch_hz
    note            — octave-qualified string e.g. 'A4'
    cents           — tuning offset from nearest semitone (±50)
    beat_offset_ms  — signed ms from nearest beat (negative=early, positive=late)
    beat_time_s     — time of nearest beat on the grid
    timing          — 'on' / 'close' / 'early' / 'late'
    scale_status    — 'correct' / 'close' / 'wrong'
"""

from __future__ import annotations

import math
import numpy as np
from typing import Optional

# ── Guitar pitch range ────────────────────────────────────────────────────────
GUITAR_MIN_HZ = 75.0    # E2 with margin
GUITAR_MAX_HZ = 1400.0  # e5 with margin

# Pitch window relative to each onset (ms)
PITCH_WIN_MIN_MS = 20
PITCH_WIN_MAX_MS = 300

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


# ── Music helpers ─────────────────────────────────────────────────────────────

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
    """Return 'correct', 'close' (1 semitone away), or 'wrong'."""
    if not scale_notes:
        return 'correct'
    if note_name in scale_notes:
        return 'correct'
    if note_name in NOTE_NAMES:
        idx = NOTE_NAMES.index(note_name)
        if NOTE_NAMES[(idx - 1) % 12] in scale_notes or \
           NOTE_NAMES[(idx + 1) % 12] in scale_notes:
            return 'close'
    return 'wrong'


# ── Beat alignment ────────────────────────────────────────────────────────────

def _find_beat_phase(onset_times_s: list[float], beat_sec: float) -> float:
    """200-candidate brute-force beat phase alignment."""
    if not onset_times_s or beat_sec <= 0:
        return 0.0
    best_phase, best_err = 0.0, float('inf')
    for i in range(200):
        candidate = (i / 200) * beat_sec
        err = sum(
            min(
                ((t - candidate) % beat_sec + beat_sec) % beat_sec,
                beat_sec - ((t - candidate) % beat_sec + beat_sec) % beat_sec,
            )
            for t in onset_times_s
        )
        if err < best_err:
            best_err, best_phase = err, candidate
    return best_phase


def _signed_beat_offset_ms(time_s: float, beat_sec: float, phase_s: float) -> float:
    """Signed ms offset from nearest beat (negative=early, positive=late)."""
    if beat_sec <= 0:
        return 0.0
    pos    = ((time_s - phase_s) % beat_sec + beat_sec) % beat_sec
    signed = pos - beat_sec if pos > beat_sec / 2 else pos
    return round(signed * 1000, 1)


def _timing_label(offset_ms: float) -> str:
    a = abs(offset_ms)
    if a < 20:  return 'on'
    if a < 60:  return 'close'
    return 'early' if offset_ms < 0 else 'late'


def _classify_note_type(duration_ms: float, beat_sec: float) -> str:
    """Classify note length relative to BPM.

    - short:    < one 16th note (beat/4)  — staccato / pick artifact
    - sustained: > 1.5 beats              — held / legato
    - normal:   everything in between
    """
    beat_ms = beat_sec * 1000.0
    if duration_ms < beat_ms * 0.25:
        return 'short'
    if duration_ms > beat_ms * 1.5:
        return 'sustained'
    return 'normal'


# ── Main pipeline ─────────────────────────────────────────────────────────────

def detect_notes(
    signal:      np.ndarray,
    sr:          int,
    bpm:         float = 120.0,
    scale_notes: Optional[list[str]] = None,
    a4:          float = 440.0,
    latency_ms:  float = 0.0,
) -> list[dict]:
    """Detect notes in a mono float32 audio signal using librosa.

    Parameters
    ----------
    signal      : mono float32 ndarray
    sr          : sample rate (Hz)
    bpm         : tempo for beat-grid alignment
    scale_notes : list of note name strings for scale correctness check, or None
    a4          : A4 tuning reference (Hz)
    latency_ms  : system latency correction subtracted from onset times

    Returns
    -------
    List of note dicts sorted by time_s.
    """
    import librosa

    signal = np.asarray(signal, dtype=np.float32)
    if signal.ndim > 1:
        signal = signal[:, 0]

    hop_length = 512   # ~12 ms at 44100 Hz

    # ── Pass 1: pyin pitch track ──────────────────────────────────────────
    # pyin returns (f0, voiced_flag, voiced_probs) per frame
    f0, voiced_flag, voiced_probs = librosa.pyin(
        signal,
        fmin=GUITAR_MIN_HZ,
        fmax=GUITAR_MAX_HZ,
        sr=sr,
        hop_length=hop_length,
        fill_na=None,
    )
    # Build a time → (freq, confidence) lookup for voiced frames
    frame_times_s = librosa.times_like(f0, sr=sr, hop_length=hop_length)
    pitch_frames: list[tuple[float, float, float]] = []   # (time_ms, freq, confidence)
    for t, freq, vflag, vprob in zip(frame_times_s, f0, voiced_flag, voiced_probs):
        if vflag and freq is not None and not np.isnan(freq):
            if GUITAR_MIN_HZ <= freq <= GUITAR_MAX_HZ:
                pitch_frames.append((float(t) * 1000.0, float(freq), float(vprob)))

    # ── Pass 2: onset detection ───────────────────────────────────────────
    # onset_detect returns sample indices; backtrack=True snaps to local energy
    onset_samples = librosa.onset.onset_detect(
        y=signal,
        sr=sr,
        hop_length=hop_length,
        backtrack=True,
        units='samples',
    )

    # Convert to ms and enforce minimum gap (150 ms)
    MIN_GAP_MS = 150.0
    raw_onset_ms: list[float] = []
    for s in onset_samples:
        t_ms = (float(s) / sr) * 1000.0
        if not raw_onset_ms or t_ms - raw_onset_ms[-1] >= MIN_GAP_MS:
            raw_onset_ms.append(t_ms)

    # ── Pass 3: match sustained pitch to each onset ───────────────────────
    latency_s = latency_ms / 1000.0
    beat_sec  = 60.0 / bpm if bpm > 0 else 0.5
    raw_notes: list[dict] = []

    for onset_ms in raw_onset_ms:
        win_lo = onset_ms + PITCH_WIN_MIN_MS
        win_hi = onset_ms + PITCH_WIN_MAX_MS

        window = [
            (freq, conf) for (t_ms, freq, conf) in pitch_frames
            if win_lo <= t_ms <= win_hi
        ]

        if not window:
            # Widen search if sustain window is empty
            window = [
                (freq, conf) for (t_ms, freq, conf) in pitch_frames
                if onset_ms <= t_ms <= onset_ms + PITCH_WIN_MAX_MS + 200
            ]

        if not window:
            continue   # onset with no identifiable pitch — skip

        freqs = [f for f, _ in window]
        confs = [c for _, c in window]

        freq_hz    = float(np.median(freqs))
        confidence = float(np.mean(confs))

        if not (GUITAR_MIN_HZ <= freq_hz <= GUITAR_MAX_HZ):
            continue

        note_name, octave, cents, note_str = _freq_to_note(freq_hz, a4)
        time_s = max(0.0, round(onset_ms / 1000.0 - latency_s, 3))

        raw_notes.append({
            'time_s':     time_s,
            'start_ms':   round(time_s * 1000.0, 1),
            'freq_hz':    round(freq_hz, 2),
            'pitch_hz':   round(freq_hz, 2),
            'note':       note_str,
            'note_name':  note_name,
            'cents':      cents,
            'confidence': round(min(1.0, max(0.0, confidence)), 3),
        })

    # Sort by time
    raw_notes.sort(key=lambda n: n['time_s'])

    # ── Estimate durations ────────────────────────────────────────────────
    for i, note in enumerate(raw_notes):
        next_time = raw_notes[i + 1]['time_s'] if i + 1 < len(raw_notes) else note['time_s'] + 0.5
        note['duration_ms'] = round(min(next_time - note['time_s'], 2.0) * 1000.0, 1)

    # ── Beat alignment ────────────────────────────────────────────────────
    onset_times_s = [n['time_s'] for n in raw_notes]
    phase_s       = _find_beat_phase(onset_times_s, beat_sec)

    for note in raw_notes:
        offset_ms   = _signed_beat_offset_ms(note['time_s'], beat_sec, phase_s)
        pos         = ((note['time_s'] - phase_s) % beat_sec + beat_sec) % beat_sec
        nearest_off = pos - beat_sec if pos > beat_sec / 2 else pos
        beat_time_s = round(note['time_s'] - nearest_off, 3)

        note['beat_offset_ms'] = offset_ms
        note['beat_time_s']    = beat_time_s
        note['timing']         = _timing_label(offset_ms)
        note['scale_status']   = _scale_correctness(note['note_name'], scale_notes)
        note['note_type']      = _classify_note_type(note['duration_ms'], beat_sec)

    return raw_notes
