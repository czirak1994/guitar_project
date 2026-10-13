"""Librosa-based note detection pipeline.

Algorithm
---------
1. Onset detection  — librosa.onset.onset_detect (spectral flux, backtracked),
                      then gated against an RMS noise floor so background
                      noise / pick scratches on a clean channel aren't
                      reported as notes.
2. Pitch estimation — librosa.pyin (probabilistic YIN, voiced frames only)
3. Per-onset pitch  — frames in the 20-150 ms post-onset window are filtered
                      by confidence, then snapped to the nearest MIDI note;
                      the *mode* note wins (median Hz within that mode group
                      gives the cents reading). This avoids octave errors
                      from a handful of frames where pYIN locks onto a
                      harmonic/sub-harmonic late in the window.
4. Duration         — release-based: walks the RMS envelope forward from the
                      onset until it decays back to the noise floor (or the
                      next onset), instead of assuming a note lasts until the
                      next detected onset.
5. Beat alignment   — 200-candidate brute-force phase search (same as frontend)
6. Scale correctness— 'correct' / 'close' / 'wrong' vs optional scale_notes list

Public API
----------
detect_notes(signal, sr, bpm=120.0, scale_notes=None, a4=440.0, latency_ms=0.0,
             noise_floor_db=None)
    -> list[dict]

Each dict contains:
    start_ms        — onset time in ms (latency-corrected)
    duration_ms     — estimated duration from energy release (max 2 s)
    pitch_hz        — mode-note median pitch in sustain window (Hz)
    note_name       — e.g. 'A', 'C#'
    confidence      — mean pyin confidence of the winning frames (0–1)
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
from collections import Counter
import numpy as np
from typing import Optional

# ── Guitar pitch range ────────────────────────────────────────────────────────
GUITAR_MIN_HZ = 75.0    # E2 with margin
GUITAR_MAX_HZ = 1400.0  # e5 with margin

# Pitch window relative to each onset (ms).
# Kept tight and close to the attack: the further into the sustain/decay we
# sample, the weaker the fundamental gets relative to its own harmonics on
# low guitar strings (E2/A2/D3), which is what causes pYIN octave errors.
PITCH_WIN_MIN_MS = 20
PITCH_WIN_MAX_MS = 150
PITCH_MIN_CONFIDENCE = 0.5   # pyin voiced_prob cutoff for a frame to count

# Energy gating (noise floor)
DEFAULT_NOISE_FLOOR_DB = -50.0
ONSET_GATE_MARGIN_DB = 6.0    # an onset must clear floor + this margin
RELEASE_MARGIN_DB = 3.0       # a note "ends" once it decays back to floor + this
ONSET_RISE_GATE_DB = 8.0      # an onset must also be this much louder than ~100ms before it

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
    signal:         np.ndarray,
    sr:             int,
    bpm:            float = 120.0,
    scale_notes:    Optional[list[str]] = None,
    a4:             float = 440.0,
    latency_ms:     float = 0.0,
    noise_floor_db: Optional[float] = None,
) -> list[dict]:
    """Detect notes in a mono float32 audio signal using librosa.

    Parameters
    ----------
    signal         : mono float32 ndarray
    sr             : sample rate (Hz)
    bpm            : tempo for beat-grid alignment
    scale_notes    : list of note name strings for scale correctness check, or None
    a4             : A4 tuning reference (Hz)
    latency_ms     : system latency correction subtracted from onset times
    noise_floor_db : per-device noise floor (from CalibrationModal), or None to
                     fall back to DEFAULT_NOISE_FLOOR_DB. Onsets must clear
                     floor + ONSET_GATE_MARGIN_DB to be accepted, and notes are
                     considered released once they decay back to floor + RELEASE_MARGIN_DB.

    Returns
    -------
    List of note dicts sorted by time_s.
    """
    import librosa
    from dsp.amplitude import rms_to_db

    signal = np.asarray(signal, dtype=np.float32)
    if signal.ndim > 1:
        signal = signal[:, 0]

    hop_length = 512   # ~12 ms at 44100 Hz
    floor_db = DEFAULT_NOISE_FLOOR_DB if noise_floor_db is None else noise_floor_db

    # RMS energy envelope, used both to gate onsets against noise and to find
    # each note's release point later on.
    rms_frame_length = 2048
    rms_env = librosa.feature.rms(y=signal, frame_length=rms_frame_length, hop_length=hop_length)[0]
    rms_times_ms = librosa.times_like(rms_env, sr=sr, hop_length=hop_length) * 1000.0

    def _rms_db_at(t_ms: float, window_ms: float = 40.0) -> float:
        """Mean RMS-in-dB over [t_ms, t_ms + window_ms]."""
        mask = (rms_times_ms >= t_ms) & (rms_times_ms <= t_ms + window_ms)
        if not np.any(mask):
            return -100.0
        return rms_to_db(float(np.mean(rms_env[mask])))

    def _rise_db_at(t_ms: float, lookback_ms: float = 100.0) -> float:
        """How much louder t_ms is than the window just before it.

        A real pluck is a sudden jump from whatever came before (silence, or
        a previous note that had already decayed). A noise burst that lands
        on top of an *already-ringing* note is not: the note is already loud
        there, so the burst barely raises the level. Gating on this rise
        (rather than on absolute level alone) is what tells the two apart.
        """
        return _rms_db_at(t_ms) - _rms_db_at(max(0.0, t_ms - lookback_ms))

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

    # Convert to ms, enforce minimum gap (150 ms), and gate out onsets that
    # don't clear the noise floor or don't represent a real rise in energy —
    # this is what stops pick scratches, fret buzz, and room/amp noise (even
    # noise landing on top of an already-ringing note) from being reported as
    # separate notes.
    MIN_GAP_MS = 150.0
    onset_gate_db = floor_db + ONSET_GATE_MARGIN_DB
    raw_onset_ms: list[float] = []
    for s in onset_samples:
        t_ms = (float(s) / sr) * 1000.0
        if raw_onset_ms and t_ms - raw_onset_ms[-1] < MIN_GAP_MS:
            continue
        if _rms_db_at(t_ms) < onset_gate_db:
            continue
        if _rise_db_at(t_ms) < ONSET_RISE_GATE_DB:
            continue
        raw_onset_ms.append(t_ms)

    # ── Pass 3: match sustained pitch to each onset ───────────────────────
    latency_s = latency_ms / 1000.0
    beat_sec  = 60.0 / bpm if bpm > 0 else 0.5
    raw_notes: list[dict] = []

    for onset_ms in raw_onset_ms:
        win_lo = onset_ms + PITCH_WIN_MIN_MS
        win_hi = onset_ms + PITCH_WIN_MAX_MS

        def _window(lo, hi, min_conf):
            return [
                (freq, conf) for (t_ms, freq, conf) in pitch_frames
                if lo <= t_ms <= hi and conf >= min_conf
            ]

        window = _window(win_lo, win_hi, PITCH_MIN_CONFIDENCE)
        if not window:
            # Widen search and relax confidence if the tight window is empty
            window = _window(onset_ms, onset_ms + PITCH_WIN_MAX_MS + 200, 0.3)

        if not window:
            continue   # onset with no identifiable pitch — skip

        # Snap each frame to its nearest MIDI note and take the *mode* note —
        # this is what makes the estimate robust to a few frames where pYIN
        # locked onto a harmonic/sub-harmonic (octave error) instead of the
        # true fundamental, which a plain median-of-Hz is vulnerable to.
        midi_notes = [round(69.0 + 12.0 * math.log2(f / a4)) for f, _ in window]
        winning_midi, _ = Counter(midi_notes).most_common(1)[0]
        agreeing = [(f, c) for (f, c), m in zip(window, midi_notes) if m == winning_midi]

        freqs = [f for f, _ in agreeing]
        confs = [c for _, c in agreeing]

        freq_hz    = float(np.median(freqs))
        confidence = float(np.mean(confs))

        if not (GUITAR_MIN_HZ <= freq_hz <= GUITAR_MAX_HZ):
            continue

        note_name, octave, cents, note_str = _freq_to_note(freq_hz, a4)
        time_s = max(0.0, round(onset_ms / 1000.0 - latency_s, 3))

        raw_notes.append({
            'time_s':     time_s,
            'start_ms':   round(time_s * 1000.0, 1),
            'onset_ms':   onset_ms,   # kept for release-based duration below
            'freq_hz':    round(freq_hz, 2),
            'pitch_hz':   round(freq_hz, 2),
            'note':       note_str,
            'note_name':  note_name,
            'cents':      cents,
            'confidence': round(min(1.0, max(0.0, confidence)), 3),
        })

    # Sort by time
    raw_notes.sort(key=lambda n: n['time_s'])

    # ── Estimate durations from energy release, not just "next onset" ─────
    # A note ends when its energy decays back to the noise floor, or when the
    # next onset starts — whichever comes first. Without this, a single held
    # note that triggers a spurious extra onset mid-decay gets sliced into
    # multiple short, mis-pitched fragments.
    release_gate_db = floor_db + RELEASE_MARGIN_DB
    MAX_DURATION_MS = 2000.0
    for i, note in enumerate(raw_notes):
        onset_ms = note.pop('onset_ms')
        next_onset_ms = raw_notes[i + 1]['onset_ms'] if i + 1 < len(raw_notes) else onset_ms + MAX_DURATION_MS
        search_end_ms = min(next_onset_ms, onset_ms + MAX_DURATION_MS)

        release_ms = search_end_ms
        # Skip past the attack transient itself so a momentary dip right at
        # the pick strike can't be mistaken for an immediate release.
        mask = (rms_times_ms >= onset_ms + 15.0) & (rms_times_ms <= search_end_ms)
        env_db = 20.0 * np.log10(np.maximum(rms_env[mask], 1e-12))
        idx = np.flatnonzero(env_db < release_gate_db)
        if idx.size:
            release_ms = rms_times_ms[mask][idx[0]]

        note['duration_ms'] = round(max(30.0, release_ms - onset_ms), 1)

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
