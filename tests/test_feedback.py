"""Tests for the feedback engine."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analysis.timing import TimingAnalyzer
from analysis.accuracy import PitchAccuracyAnalyzer
from analysis.error_detection import ErrorDetector
from feedback.engine import FeedbackEngine


class TestFeedbackEngine:
    """Test the feedback engine end-to-end."""

    def setup_method(self):
        self.engine = FeedbackEngine()
        self.timing_analyzer = TimingAnalyzer(tolerance_ms=50.0)
        self.accuracy_analyzer = PitchAccuracyAnalyzer(tolerance_cents=50.0)

    def test_generates_report_perfect_session(self):
        """Perfect session should generate positive feedback."""
        onsets = [0.0, 0.5, 1.0, 1.5]
        timing = self.timing_analyzer.analyze_vs_metronome(onsets, bpm=120)

        detected = [
            {"time_s": 0.0, "freq_hz": 440.0, "confidence": 0.95},
            {"time_s": 0.5, "freq_hz": 440.0, "confidence": 0.90},
        ]
        accuracy = self.accuracy_analyzer.analyze(detected, detected)

        report = self.engine.generate(
            timing=timing, accuracy=accuracy,
            detected_notes=detected, amplitude_db=-15.0
        )

        assert report.accuracy_pct == 100.0
        assert report.on_time_ratio == 1.0
        assert len(report.messages) > 0
        # Should have positive messages
        positive = [m for m in report.messages if "✅" in m or "👍" in m]
        assert len(positive) > 0

    def test_generates_errors_for_bad_session(self):
        """Bad timing should generate error messages."""
        onsets = [0.08, 0.58, 1.08, 1.58]  # all 80ms late
        timing = self.timing_analyzer.analyze_vs_metronome(onsets, bpm=120)

        report = self.engine.generate(timing=timing, amplitude_db=-40.0)

        assert len(report.errors) > 0
        assert any("late" in e["message"].lower() for e in report.errors)

    def test_json_serialization(self):
        """Report should serialize to valid JSON."""
        import json
        report = self.engine.generate()
        json_str = report.to_json()
        parsed = json.loads(json_str)
        assert "messages" in parsed
        assert "errors" in parsed

    def test_empty_session(self):
        """Empty session should produce a 'no notes detected' message."""
        report = self.engine.generate()
        assert any("no notes" in m.lower() for m in report.messages)

    def test_report_dict_structure(self):
        """Report dict should have all expected keys."""
        report = self.engine.generate()
        d = report.to_dict()
        expected_keys = [
            "notes", "timing_error_ms", "timing_std_ms",
            "timing_consistency", "on_time_ratio",
            "pitch_error_cents", "accuracy_pct",
            "correct_notes", "total_notes",
            "amplitude_db", "errors", "messages",
        ]
        for key in expected_keys:
            assert key in d, f"Missing key: {key}"
