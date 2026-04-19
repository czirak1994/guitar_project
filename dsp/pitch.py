"""YIN pitch detection algorithm (pure numpy implementation).

Reference: de Cheveigné, A., & Kawahara, H. (2002).
"YIN, a fundamental frequency estimator for speech and music."
"""

import numpy as np


def _difference_function(signal: np.ndarray, max_lag: int) -> np.ndarray:
    """Step 2 of YIN: compute the difference function d(tau)."""
    n = len(signal)
    df = np.zeros(max_lag)
    for tau in range(1, max_lag):
        df[tau] = np.sum((signal[:n - max_lag] - signal[tau:tau + n - max_lag]) ** 2)
    return df


def _cumulative_mean_normalized_difference(df: np.ndarray) -> np.ndarray:
    """Step 3 of YIN: cumulative mean normalized difference function d'(tau)."""
    cmndf = np.zeros_like(df)
    cmndf[0] = 1.0
    running_sum = 0.0
    for tau in range(1, len(df)):
        running_sum += df[tau]
        if running_sum == 0:
            cmndf[tau] = 1.0
        else:
            cmndf[tau] = df[tau] * tau / running_sum
    return cmndf


def _absolute_threshold(cmndf: np.ndarray, threshold: float) -> int:
    """Step 4: find first dip below threshold, then pick the minimum in that valley."""
    for tau in range(2, len(cmndf)):
        if cmndf[tau] < threshold:
            # Walk forward to find the local minimum
            while tau + 1 < len(cmndf) and cmndf[tau + 1] < cmndf[tau]:
                tau += 1
            return tau
    # No dip found — return the global minimum (excluding tau=0)
    return int(np.argmin(cmndf[1:])) + 1


def _parabolic_interpolation(cmndf: np.ndarray, tau: int) -> float:
    """Step 5: refine the estimated tau with parabolic interpolation."""
    if tau <= 0 or tau >= len(cmndf) - 1:
        return float(tau)

    s0 = cmndf[tau - 1]
    s1 = cmndf[tau]
    s2 = cmndf[tau + 1]

    denom = 2.0 * (2.0 * s1 - s2 - s0)
    if abs(denom) < 1e-10:
        return float(tau)

    return tau + (s2 - s0) / denom


def yin_pitch(signal: np.ndarray, sr: int,
              fmin: float = 60.0, fmax: float = 1200.0,
              threshold: float = 0.15) -> tuple[float, float]:
    """Detect fundamental frequency using the YIN algorithm.

    Args:
        signal: mono audio frame (1D numpy array, float32).
        sr: sample rate in Hz.
        fmin: minimum detectable frequency (Hz).
        fmax: maximum detectable frequency (Hz).
        threshold: YIN confidence threshold (lower = stricter).

    Returns:
        (frequency_hz, confidence)
        - frequency_hz: detected f0, or 0.0 if unvoiced.
        - confidence: 1 - cmndf[tau], range [0, 1], higher = more confident.
    """
    if len(signal) < 2:
        return 0.0, 0.0

    # Silence check — avoid spurious detections on zero/near-zero signal
    if np.sqrt(np.mean(signal ** 2)) < 1e-6:
        return 0.0, 0.0

    # Lag range corresponds to frequency range
    min_lag = max(2, int(sr / fmax))
    max_lag = min(len(signal) // 2, int(sr / fmin))

    if max_lag <= min_lag:
        return 0.0, 0.0

    # Steps 2-3
    df = _difference_function(signal, max_lag)
    cmndf = _cumulative_mean_normalized_difference(df)

    # Step 4: threshold search (only in valid lag range)
    tau = _absolute_threshold(cmndf[min_lag:max_lag], threshold)
    tau += min_lag  # offset back to full array index

    if tau >= max_lag:
        return 0.0, 0.0

    # Step 5: parabolic interpolation for sub-sample accuracy
    refined_tau = _parabolic_interpolation(cmndf, tau)

    if refined_tau <= 0:
        return 0.0, 0.0

    freq = sr / refined_tau
    confidence = 1.0 - cmndf[tau]

    return float(freq), float(max(0.0, min(1.0, confidence)))


def yin_pitch_track(signal: np.ndarray, sr: int,
                    frame_size: int = 2048, hop_size: int = 512,
                    **kwargs) -> list[dict]:
    """Track pitch over an entire signal.

    Returns:
        List of dicts: {"time_s": float, "freq_hz": float, "confidence": float}
    """
    results = []
    n = len(signal)

    for start in range(0, n - frame_size + 1, hop_size):
        frame = signal[start:start + frame_size]
        freq, conf = yin_pitch(frame, sr, **kwargs)
        time_s = start / sr
        results.append({
            "time_s": round(time_s, 6),
            "freq_hz": round(freq, 2),
            "confidence": round(conf, 4),
        })

    return results
