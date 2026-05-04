"""basic-pitch (Spotify) note detection pipeline.

Replaces the librosa-based onset+pyin pipeline.
The pre-trained neural network handles onset, pitch, and duration together —
no hardcoded thresholds, device-agnostic.

Public API
----------
detect_notes(signal, sr, bpm=120.0, scale_notes=None, a4=440.0, latency_ms=0.0)
    -> list[dict]

Each dict contains the same fields as librosa_notes for drop-in compatibility:
    start_ms, duration_ms, pitch_hz, note_name, confidence, time_s, freq_hz,
    note, cents, beat_offset_ms, beat_time_s, timing, scale_status
"""

from __future__ import annotations

import math
import os
import tempfile
from typing import Optional

import numpy as np
import soundfile as sf

# Guitar pitch range used to filter the model output
GUITAR_MIN_HZ = 75.0    # E2 with margin
GUITAR_MAX_HZ = 1400.0  # e5 with margin

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# Lazy-loaded model handle — loaded once on first call
_model = None


def _get_model():
    global _model
    if _model is None:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model
        _model = Model(ICASSP_2022_MODEL_PATH)
    return _model


# ── Music helpers ─────────────────────────────────────────────────────────────

def _midi_to_hz(midi: int) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def _freq_to_note(freq_hz: float, a4: float = 440.0) -> tuple[str, int, float, str]:
    if freq_hz <= 0:
        return ('?', 0, 0.0, '?')
    semitones = 12.0 * math.log2(freq_hz / a4)
    midi = round(semitones) + 69
    cents = (semitones - (midi - 69)) * 100.0
    octave = (midi // 12) - 1
    name = NOTE_NAMES[midi % 12]
    return (name, octave, round(cents, 1), f'{name}{octave}')


def _scale_correctness(note_name: str, scale_notes: Optional[list[str]]) -> str:
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
    if not onset_times_s or beat_sec <= 0:
        return 0.0
    candidates = np.linspace(0, beat_sec, 200, endpoint=False)
    best_phase, best_score = 0.0, float('inf')
    for phase in candidates:
        residuals = np.array([(t - phase) % beat_sec for t in onset_times_s])
        residuals = np.where(residuals > beat_sec / 2, residuals - beat_sec, residuals)
        score = float(np.mean(residuals ** 2))
        if score < best_score:
            best_score, best_phase = score, phase
    return best_phase


def _classify_timing(beat_offset_ms: float) -> str:
    if abs(beat_offset_ms) < 30:
        return 'on'
    if abs(beat_offset_ms) < 80:
        return 'close'
    return 'early' if beat_offset_ms < 0 else 'late'


# ── Main API ──────────────────────────────────────────────────────────────────

def detect_notes(
    signal: np.ndarray,
    sr: int,
    bpm: float = 120.0,
    scale_notes: Optional[list[str]] = None,
    a4: float = 440.0,
    latency_ms: float = 0.0,
) -> list[dict]:
    """Detect notes using the basic-pitch neural network model.

    Parameters are identical to librosa_notes.detect_notes() for drop-in use.
    """
    from basic_pitch.inference import predict

    latency_s = latency_ms / 1000.0
    model = _get_model()

    # Write to temp WAV — basic-pitch handles resampling to 22050 Hz internally
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            tmp_path = tmp.name
        sf.write(tmp_path, signal, sr)

        _, _, note_events = predict(
            tmp_path,
            model,
            onset_threshold=0.5,       # higher = fewer false positives
            frame_threshold=0.3,
            minimum_note_length=80,    # ms — ignores sub-80ms blips (pick noise)
            minimum_frequency=GUITAR_MIN_HZ,
            maximum_frequency=GUITAR_MAX_HZ,
        )
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    if not note_events:
        return []

    # Beat grid alignment
    beat_sec = 60.0 / max(bpm, 1.0)
    onset_times = [ev[0] for ev in note_events]
    phase = _find_beat_phase(onset_times, beat_sec)

    results = []
    for event in note_events:
        start_s, end_s, pitch_midi, amplitude = event[0], event[1], event[2], event[3]

        start_adj = start_s - latency_s
        pitch_hz = _midi_to_hz(pitch_midi)
        note_name, octave, cents, note_str = _freq_to_note(pitch_hz, a4)
        duration_ms = (end_s - start_s) * 1000.0

        t_rel = (start_adj - phase) % beat_sec
        if t_rel > beat_sec / 2:
            t_rel -= beat_sec
        beat_offset_ms = round(t_rel * 1000.0, 1)
        beat_time_s = round(start_adj - t_rel, 3)

        results.append({
            'start_ms':       round(start_adj * 1000, 1),
            'duration_ms':    round(duration_ms, 1),
            'pitch_hz':       round(pitch_hz, 2),
            'note_name':      note_name,
            'confidence':     round(float(amplitude), 3),
            'time_s':         round(start_adj, 3),
            'freq_hz':        round(pitch_hz, 2),
            'note':           note_str,
            'cents':          cents,
            'beat_offset_ms': beat_offset_ms,
            'beat_time_s':    beat_time_s,
            'timing':         _classify_timing(beat_offset_ms),
            'scale_status':   _scale_correctness(note_name, scale_notes),
        })

    return results
