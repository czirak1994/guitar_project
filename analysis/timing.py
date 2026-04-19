"""Timing analysis — compare played note timings against a reference grid."""

from dataclasses import dataclass
import numpy as np
from typing import Optional


@dataclass
class TimingResult:
    """Result for a single note's timing analysis."""
    expected_time_s: float
    actual_time_s: float
    deviation_ms: float       # positive = late, negative = early
    is_on_time: bool
    is_late: bool
    is_early: bool


@dataclass
class TimingReport:
    """Aggregate timing analysis report."""
    results: list[TimingResult]
    mean_deviation_ms: float
    std_deviation_ms: float
    median_deviation_ms: float
    consistency_score: float   # 0-100, higher = more consistent
    on_time_ratio: float       # fraction of notes within tolerance
    phase_offset_ms: float = 0.0  # auto-detected beat phase offset


class TimingAnalyzer:
    """Analyzes timing accuracy of played notes against a reference.

    Supports two modes:
    1. Metronome grid: evenly-spaced beats at a given BPM
    2. Note sequence: custom list of expected onset times
    """

    def __init__(self, tolerance_ms: float = 50.0):
        self.tolerance_ms = tolerance_ms

    def analyze_vs_metronome(self, onset_times_s: list[float],
                              bpm: float,
                              start_time_s: float = 0.0,
                              subdivisions: int = 1,
                              auto_align: bool = True) -> TimingReport:
        """Compare onset times against a metronome grid.

        Args:
            onset_times_s: detected note onset times (seconds)
            bpm: tempo in beats per minute
            start_time_s: time of the first beat (used only when auto_align=False)
            subdivisions: 1=quarter notes, 2=eighth notes, etc.
            auto_align: if True, automatically find the phase offset that best
                        fits the played notes — fixes the "all notes late+early"
                        bug that occurs when the player doesn't start on beat 1.

        Returns:
            TimingReport with per-note and aggregate analysis.
        """
        if not onset_times_s or bpm <= 0:
            return self._empty_report()

        beat_interval_s = 60.0 / (bpm * subdivisions)

        if auto_align:
            best_phase = self._find_best_phase(onset_times_s, beat_interval_s)
        else:
            best_phase = start_time_s % beat_interval_s

        # Generate grid beats that span the range of played notes
        max_time = max(onset_times_s) + beat_interval_s
        grid = []
        t = best_phase
        # Walk back to ensure grid covers times before the first note
        while t > min(onset_times_s) - beat_interval_s:
            t -= beat_interval_s
        while t <= max_time:
            grid.append(t)
            t += beat_interval_s

        report = self._match_and_analyze(onset_times_s, grid)
        report.phase_offset_ms = round(best_phase * 1000.0, 1)
        return report

    def analyze_vs_sequence(self, onset_times_s: list[float],
                             expected_times_s: list[float]) -> TimingReport:
        """Compare onset times against a predefined note sequence.

        Args:
            onset_times_s: detected note onset times (seconds)
            expected_times_s: expected onset times (seconds)

        Returns:
            TimingReport
        """
        if not onset_times_s or not expected_times_s:
            return self._empty_report()

        return self._match_and_analyze(onset_times_s, expected_times_s)

    # ── Private helpers ───────────────────────────────────────────────────────

    def _find_best_phase(self, onset_times: list[float],
                          beat_interval_s: float) -> float:
        """Brute-force search for the beat phase that minimises total error.

        Searches 100 equally-spaced candidate phases within one beat interval.
        Returns the phase (seconds) that minimises the sum of absolute
        deviations from the nearest grid beat across all onset times.
        This eliminates the systematic "alternating late/early" artefact
        caused by starting on a non-zero phase.
        """
        times = np.asarray(onset_times, dtype=float)
        phases = np.linspace(0.0, beat_interval_s, 200, endpoint=False)
        best_phase = 0.0
        best_err = float("inf")

        for phase in phases:
            # Snap each onset to its nearest grid beat for this candidate phase
            # Grid beat for time t is: phase + round((t - phase) / interval) * interval
            relative = (times - phase) / beat_interval_s
            nearest_beats = phase + np.round(relative) * beat_interval_s
            err = float(np.sum(np.abs(times - nearest_beats)))
            if err < best_err:
                best_err = err
                best_phase = float(phase)

        return best_phase

    def _match_and_analyze(self, actual_times: list[float],
                           expected_times: list[float]) -> TimingReport:
        """Match each played note to the nearest expected time and compute deviation."""
        expected = np.array(sorted(expected_times))
        results = []

        for actual_t in sorted(actual_times):
            # Find nearest expected beat
            diffs = np.abs(expected - actual_t)
            nearest_idx = int(np.argmin(diffs))
            expected_t = expected[nearest_idx]

            deviation_ms = (actual_t - expected_t) * 1000.0

            results.append(TimingResult(
                expected_time_s=round(expected_t, 6),
                actual_time_s=round(actual_t, 6),
                deviation_ms=round(deviation_ms, 2),
                is_on_time=abs(deviation_ms) <= self.tolerance_ms,
                is_late=deviation_ms > self.tolerance_ms,
                is_early=deviation_ms < -self.tolerance_ms,
            ))

        return self._build_report(results)

    def _build_report(self, results: list[TimingResult]) -> TimingReport:
        """Compute aggregate stats from per-note results."""
        if not results:
            return self._empty_report()

        deviations = [r.deviation_ms for r in results]
        on_time_count = sum(1 for r in results if r.is_on_time)

        mean_dev = float(np.mean(deviations))
        std_dev = float(np.std(deviations))
        median_dev = float(np.median(deviations))

        # Consistency: based on std — lower std = higher score
        # Score of 100 when std=0, drops to 0 around std=100ms
        consistency = max(0.0, 100.0 * (1.0 - std_dev / 100.0))

        return TimingReport(
            results=results,
            mean_deviation_ms=round(mean_dev, 2),
            std_deviation_ms=round(std_dev, 2),
            median_deviation_ms=round(median_dev, 2),
            consistency_score=round(consistency, 1),
            on_time_ratio=round(on_time_count / len(results), 4),
        )

    def _empty_report(self) -> TimingReport:
        return TimingReport(
            results=[],
            mean_deviation_ms=0.0,
            std_deviation_ms=0.0,
            median_deviation_ms=0.0,
            consistency_score=0.0,
            on_time_ratio=0.0,
        )
