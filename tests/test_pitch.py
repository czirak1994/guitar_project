"""Tests for YIN pitch detection."""

import numpy as np
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dsp.pitch import yin_pitch, yin_pitch_track


def _generate_sine(freq_hz: float, duration_s: float = 0.1,
                   sr: int = 44100) -> np.ndarray:
    """Generate a pure sine wave."""
    t = np.arange(int(sr * duration_s)) / sr
    return (0.8 * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)


class TestYinPitch:
    """Test YIN pitch detection on synthetic sine waves."""

    def test_a4_440(self):
        """A4 = 440 Hz should be detected accurately."""
        signal = _generate_sine(440.0, duration_s=0.1, sr=44100)
        freq, conf = yin_pitch(signal, 44100)
        assert abs(freq - 440.0) < 5.0, f"Expected ~440Hz, got {freq}"
        assert conf > 0.8, f"Confidence too low: {conf}"

    def test_e2_low(self):
        """E2 = 82.41 Hz (low E string) should be detected."""
        signal = _generate_sine(82.41, duration_s=0.15, sr=44100)
        freq, conf = yin_pitch(signal, 44100, fmin=60.0)
        assert abs(freq - 82.41) < 3.0, f"Expected ~82Hz, got {freq}"
        assert conf > 0.7, f"Confidence too low: {conf}"

    def test_e4_high(self):
        """E4 = 329.63 Hz (high E string open) should be detected."""
        signal = _generate_sine(329.63, duration_s=0.1, sr=44100)
        freq, conf = yin_pitch(signal, 44100)
        assert abs(freq - 329.63) < 5.0, f"Expected ~330Hz, got {freq}"
        assert conf > 0.8

    def test_b3_string(self):
        """B3 = 246.94 Hz should be detected."""
        signal = _generate_sine(246.94, duration_s=0.1, sr=44100)
        freq, conf = yin_pitch(signal, 44100)
        assert abs(freq - 246.94) < 5.0, f"Expected ~247Hz, got {freq}"
        assert conf > 0.8

    def test_silence_returns_zero(self):
        """Silence should return freq=0."""
        signal = np.zeros(2048, dtype=np.float32)
        freq, conf = yin_pitch(signal, 44100)
        assert freq == 0.0

    def test_noise_low_confidence(self):
        """White noise should have low confidence."""
        rng = np.random.default_rng(42)
        signal = rng.standard_normal(2048).astype(np.float32) * 0.1
        freq, conf = yin_pitch(signal, 44100)
        # Noise may detect a spurious freq, but confidence should be low
        assert conf < 0.5, f"Noise confidence too high: {conf}"

    def test_pitch_track(self):
        """Pitch tracking over a longer signal should return consistent results."""
        signal = _generate_sine(440.0, duration_s=0.3, sr=44100)
        results = yin_pitch_track(signal, 44100, frame_size=2048, hop_size=512)
        assert len(results) > 0
        voiced = [r for r in results if r["freq_hz"] > 0]
        assert len(voiced) > 0
        for r in voiced:
            assert abs(r["freq_hz"] - 440.0) < 10.0
