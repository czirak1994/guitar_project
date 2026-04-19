"""Tests for pitch accuracy analysis."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analysis.accuracy import PitchAccuracyAnalyzer


class TestPitchAccuracy:
    """Test pitch accuracy scoring."""

    def setup_method(self):
        self.analyzer = PitchAccuracyAnalyzer(tolerance_cents=50.0)

    def test_perfect_accuracy(self):
        """Matching notes should give 100% accuracy."""
        detected = [
            {"time_s": 0.0, "freq_hz": 440.0, "confidence": 0.95},
            {"time_s": 0.5, "freq_hz": 329.63, "confidence": 0.9},
        ]
        expected = [
            {"time_s": 0.0, "freq_hz": 440.0},
            {"time_s": 0.5, "freq_hz": 329.63},
        ]
        report = self.analyzer.analyze(detected, expected)
        assert report.accuracy_pct == 100.0
        assert report.correct_count == 2

    def test_wrong_notes(self):
        """Completely wrong notes should score 0%."""
        detected = [
            {"time_s": 0.0, "freq_hz": 440.0, "confidence": 0.9},  # A4
        ]
        expected = [
            {"time_s": 0.0, "freq_hz": 82.41},   # E2 — totally different
        ]
        report = self.analyzer.analyze(detected, expected)
        assert report.accuracy_pct == 0.0

    def test_slightly_sharp(self):
        """A note slightly sharp (within tolerance) should still be correct."""
        # 20 cents sharp of A4
        sharp_freq = 440.0 * (2 ** (20 / 1200))
        detected = [{"time_s": 0.0, "freq_hz": sharp_freq, "confidence": 0.9}]
        expected = [{"time_s": 0.0, "freq_hz": 440.0}]
        report = self.analyzer.analyze(detected, expected)
        assert report.accuracy_pct == 100.0
        assert abs(report.mean_cents_deviation - 20) < 2

    def test_too_sharp_is_wrong(self):
        """A note 80 cents sharp should be flagged as wrong."""
        very_sharp = 440.0 * (2 ** (80 / 1200))
        detected = [{"time_s": 0.0, "freq_hz": very_sharp, "confidence": 0.9}]
        expected = [{"time_s": 0.0, "freq_hz": 440.0}]
        report = self.analyzer.analyze(detected, expected)
        assert report.accuracy_pct == 0.0

    def test_empty_input(self):
        """Empty input should give zeros."""
        report = self.analyzer.analyze([], [])
        assert report.accuracy_pct == 0.0
        assert report.total_count == 0

    def test_mixed_results(self):
        """Mix of correct and incorrect notes."""
        detected = [
            {"time_s": 0.0, "freq_hz": 440.0, "confidence": 0.9},
            {"time_s": 0.5, "freq_hz": 500.0, "confidence": 0.8},  # wrong
            {"time_s": 1.0, "freq_hz": 329.63, "confidence": 0.9},
        ]
        expected = [
            {"time_s": 0.0, "freq_hz": 440.0},
            {"time_s": 0.5, "freq_hz": 329.63},
            {"time_s": 1.0, "freq_hz": 329.63},
        ]
        report = self.analyzer.analyze(detected, expected)
        assert report.total_count == 3
        assert 0 < report.accuracy_pct < 100
