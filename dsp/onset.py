"""Onset detection — energy-based note start detection.

Uses spectral flux with peak-picking and minimum inter-onset interval
to detect when notes begin in a guitar signal.
"""

import numpy as np


def _spectral_flux(signal: np.ndarray, hop_size: int = 512,
                   win_size: int = 1024) -> np.ndarray:
    """Compute the spectral flux onset detection function.

    Spectral flux measures the positive change in spectral magnitude
    between consecutive frames — a sharp increase indicates a note onset.
    """
    n_frames = (len(signal) - win_size) // hop_size + 1
    if n_frames < 2:
        return np.array([0.0])

    window = np.hanning(win_size)
    flux = np.zeros(n_frames)
    prev_spec = np.zeros(win_size // 2 + 1)

    for i in range(n_frames):
        start = i * hop_size
        frame = signal[start:start + win_size] * window
        spec = np.abs(np.fft.rfft(frame))

        # Half-wave rectification: only positive changes (energy increase)
        diff = spec - prev_spec
        flux[i] = np.sum(np.maximum(0, diff))
        prev_spec = spec

    return flux


def _rms_envelope(signal: np.ndarray, hop_size: int = 512,
                  win_size: int = 1024) -> np.ndarray:
    """Compute RMS energy envelope."""
    n_frames = (len(signal) - win_size) // hop_size + 1
    if n_frames < 1:
        return np.array([0.0])

    env = np.zeros(n_frames)
    for i in range(n_frames):
        start = i * hop_size
        frame = signal[start:start + win_size]
        env[i] = np.sqrt(np.mean(frame ** 2))

    return env


def _pick_peaks(odf: np.ndarray, threshold: float = 0.3,
                min_interval: int = 3) -> list[int]:
    """Pick peaks from an onset detection function.

    Args:
        odf: onset detection function (1D array)
        threshold: relative threshold (fraction of max)
        min_interval: minimum frames between peaks

    Returns:
        List of frame indices where onsets were detected.
    """
    if len(odf) < 3:
        return []

    # Adaptive threshold: mean + threshold * std
    adaptive_thresh = np.mean(odf) + threshold * np.std(odf)
    # Do NOT use abs_thresh = threshold * max — that would suppress quiet notes
    # whenever one loud note inflates the max.
    effective_thresh = adaptive_thresh

    peaks = []
    last_peak = -min_interval  # allow first frame

    # Use adaptive threshold ONLY — absolute threshold (fraction of loudest peak)
    # would suppress notes quieter than threshold*max, which kills soft notes.
    # Adaptive = mean + k*std naturally adapts to the recording level.
    for i in range(1, len(odf) - 1):
        # Local maximum check
        if odf[i] > odf[i - 1] and odf[i] >= odf[i + 1]:
            # Above threshold
            if odf[i] >= effective_thresh:
                # Minimum interval check
                if (i - last_peak) >= min_interval:
                    peaks.append(i)
                    last_peak = i

    return peaks


def detect_onsets(signal: np.ndarray, sr: int,
                  hop_size: int = 512, win_size: int = 1024,
                  threshold: float = 0.3,
                  min_interval_ms: float = 80.0,
                  method: str = "spectral_flux") -> list[dict]:
    """Detect note onsets in an audio signal.

    Args:
        signal: mono audio signal (1D float32 numpy array)
        sr: sample rate
        hop_size: hop size in samples
        win_size: analysis window size in samples
        threshold: detection sensitivity (0-1, higher = fewer detections)
        min_interval_ms: minimum milliseconds between onsets
        method: "spectral_flux" or "rms"

    Returns:
        List of dicts: {"time_s": float, "sample_index": int, "strength": float}
    """
    if len(signal) < win_size:
        return []

    # Compute onset detection function
    if method == "spectral_flux":
        odf = _spectral_flux(signal, hop_size, win_size)
    elif method == "rms":
        odf = _rms_envelope(signal, hop_size, win_size)
    else:
        raise ValueError(f"Unknown onset method: {method}")

    # Normalize ODF
    odf_max = np.max(odf)
    if odf_max > 0:
        odf_norm = odf / odf_max
    else:
        return []

    # Convert minimum interval from ms to frames
    min_interval_frames = max(1, int(
        (min_interval_ms / 1000.0) * sr / hop_size
    ))

    # Pick peaks
    peak_frames = _pick_peaks(odf_norm, threshold, min_interval_frames)

    # Convert to time and sample indices
    onsets = []
    for frame_idx in peak_frames:
        sample_idx = frame_idx * hop_size
        time_s = sample_idx / sr
        onsets.append({
            "time_s": round(time_s, 6),
            "sample_index": sample_idx,
            "strength": round(float(odf_norm[frame_idx]), 4),
        })

    return onsets
