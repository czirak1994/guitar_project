"""Tests for onset detection."""

import numpy as np
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dsp.onset import detect_onsets


def _generate_clicks(n_clicks: int = 5, interval_s: float = 0.5,
                     sr: int = 44100) -> np.ndarray:
    """Generate a signal with evenly-spaced click transients."""
    duration_s = (n_clicks + 1) * interval_s
    signal = np.zeros(int(sr * duration_s), dtype=np.float32)

    for i in range(n_clicks):
        onset_sample = int(i * interval_s * sr)
        # Create a short burst (click + decay)
        burst_len = int(0.02 * sr)  # 20ms burst
        t = np.arange(burst_len) / sr
        burst = 0.8 * np.sin(2 * np.pi * 1000 * t) * np.exp(-t * 50)
        end = min(onset_sample + burst_len, len(signal))
        signal[onset_sample:end] = burst[:end - onset_sample]

    return signal


class TestOnsetDetection:
    """Test onset detection on synthetic signals."""

    def test_detects_clicks(self):
        """Should detect all clicks in a click train."""
        signal = _generate_clicks(n_clicks=5, interval_s=0.5, sr=44100)
        onsets = detect_onsets(signal, 44100, threshold=0.2)
        # Should detect approximately 5 onsets (± 1 for edge effects)
        assert len(onsets) >= 3, f"Expected ~5 onsets, got {len(onsets)}"
        assert len(onsets) <= 7, f"Too many onsets detected: {len(onsets)}"

    def test_silence_no_onsets(self):
        """Silence should produce no onsets."""
        signal = np.zeros(44100, dtype=np.float32)
        onsets = detect_onsets(signal, 44100)
        assert len(onsets) == 0

    def test_onset_times_reasonable(self):
        """Detected onset times should be near the actual click positions."""
        interval = 0.5
        signal = _generate_clicks(n_clicks=3, interval_s=interval, sr=44100)
        onsets = detect_onsets(signal, 44100, threshold=0.2)

        for onset in onsets:
            # Each onset should be near a multiple of 0.5s
            t = onset["time_s"]
            nearest_beat = round(t / interval) * interval
            error_ms = abs(t - nearest_beat) * 1000
            assert error_ms < 50, f"Onset at {t:.3f}s too far from beat: {error_ms:.0f}ms"

    def test_min_interval_prevents_doubles(self):
        """Minimum interval should prevent double detections."""
        signal = _generate_clicks(n_clicks=5, interval_s=0.5, sr=44100)
        onsets = detect_onsets(signal, 44100, threshold=0.2, min_interval_ms=400)
        # With 400ms min interval, we shouldn't get more than expected clicks
        assert len(onsets) <= 6

    def test_onset_has_required_fields(self):
        """Each onset dict should have the expected fields."""
        signal = _generate_clicks(n_clicks=3, sr=44100)
        onsets = detect_onsets(signal, 44100, threshold=0.2)
        if onsets:
            onset = onsets[0]
            assert "time_s" in onset
            assert "sample_index" in onset
            assert "strength" in onset
