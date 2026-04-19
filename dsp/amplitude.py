"""Amplitude tracking utilities."""

import numpy as np
import math


def rms_amplitude(frame: np.ndarray) -> float:
    """Compute RMS amplitude of a frame.

    Args:
        frame: 1D numpy array of audio samples

    Returns:
        RMS amplitude (linear scale)
    """
    if len(frame) == 0:
        return 0.0
    return float(np.sqrt(np.mean(frame ** 2)))


def rms_to_db(rms: float, ref: float = 1.0) -> float:
    """Convert RMS amplitude to decibels.

    Args:
        rms: RMS amplitude (linear)
        ref: reference level (default 1.0 for full-scale digital)

    Returns:
        Amplitude in dB (returns -100.0 for silence)
    """
    if rms <= 0:
        return -100.0
    return 20.0 * math.log10(rms / ref)


def db_to_rms(db: float, ref: float = 1.0) -> float:
    """Convert dB back to linear RMS."""
    return ref * (10.0 ** (db / 20.0))


def amplitude_envelope(signal: np.ndarray, hop_size: int = 512,
                       win_size: int = 1024) -> list[dict]:
    """Compute the amplitude envelope of a signal.

    Args:
        signal: 1D mono audio signal
        hop_size: hop between frames
        win_size: window size for RMS calculation

    Returns:
        List of dicts: {"sample_index": int, "rms": float, "db": float}
    """
    results = []
    n = len(signal)

    for start in range(0, n - win_size + 1, hop_size):
        frame = signal[start:start + win_size]
        rms = rms_amplitude(frame)
        db = rms_to_db(rms)
        results.append({
            "sample_index": start,
            "rms": round(rms, 6),
            "db": round(db, 2),
        })

    return results


def is_silent(frame: np.ndarray, threshold_db: float = -50.0) -> bool:
    """Check if a frame is below the silence threshold."""
    rms = rms_amplitude(frame)
    return rms_to_db(rms) < threshold_db
