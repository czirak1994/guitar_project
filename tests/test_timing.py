"""Tests for timing analysis."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analysis.timing import TimingAnalyzer


class TestTimingAnalyzer:
    """Test timing analysis against metronome grid and sequences."""

    def setup_method(self):
        self.analyzer = TimingAnalyzer(tolerance_ms=50.0)

    def test_perfect_timing(self):
        """Notes exactly on beat should have zero deviation."""
        # 120 BPM = beats at 0.0, 0.5, 1.0, 1.5, 2.0
        onsets = [0.0, 0.5, 1.0, 1.5, 2.0]
        report = self.analyzer.analyze_vs_metronome(onsets, bpm=120)
        assert abs(report.mean_deviation_ms) < 1.0
        assert report.on_time_ratio == 1.0

    def test_consistently_late(self):
        """Notes consistently 80ms late should be flagged."""
        onsets = [0.08, 0.58, 1.08, 1.58, 2.08]  # all 80ms late
        report = self.analyzer.analyze_vs_metronome(onsets, bpm=120)
        assert report.mean_deviation_ms > 70  # ~80ms late
        assert all(r.is_late for r in report.results)

    def test_consistently_early(self):
        """Notes consistently 60ms early should be flagged."""
        onsets = [-0.06, 0.44, 0.94, 1.44]  # all 60ms early
        report = self.analyzer.analyze_vs_metronome(onsets, bpm=120)
        assert report.mean_deviation_ms < -50
        assert all(r.is_early for r in report.results)

    def test_mixed_timing(self):
        """Mix of on-time and off-time notes."""
        onsets = [0.0, 0.57, 1.0, 1.6]  # first and third on time
        report = self.analyzer.analyze_vs_metronome(onsets, bpm=120)
        assert 0.0 < report.on_time_ratio < 1.0

    def test_consistency_score(self):
        """Perfect timing should have high consistency."""
        onsets = [0.0, 0.5, 1.0, 1.5]
        report = self.analyzer.analyze_vs_metronome(onsets, bpm=120)
        assert report.consistency_score > 90

    def test_vs_sequence(self):
        """Compare against a custom note sequence."""
        expected = [0.0, 0.3, 0.6, 0.9]
        actual = [0.02, 0.31, 0.59, 0.92]
        report = self.analyzer.analyze_vs_sequence(actual, expected)
        assert len(report.results) == 4
        assert abs(report.mean_deviation_ms) < 30

    def test_empty_input(self):
        """Empty input should return empty report."""
        report = self.analyzer.analyze_vs_metronome([], bpm=120)
        assert len(report.results) == 0
        assert report.on_time_ratio == 0.0
