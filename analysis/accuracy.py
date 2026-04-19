"""Pitch accuracy analysis — compare detected notes against expected notes."""

from dataclasses import dataclass
from dsp.note_utils import freq_to_note, freq_to_midi, cents_between


@dataclass
class NoteResult:
    """Result for a single note's pitch analysis."""
    time_s: float
    expected_note: str         # e.g. "E4"
    expected_freq_hz: float
    detected_note: str         # e.g. "E4" or "F4"
    detected_freq_hz: float
    cents_deviation: float     # signed
    is_correct: bool
    confidence: float


@dataclass
class AccuracyReport:
    """Aggregate pitch accuracy report."""
    results: list[NoteResult]
    correct_count: int
    total_count: int
    accuracy_pct: float           # 0-100
    mean_cents_deviation: float
    mean_abs_cents_deviation: float


class PitchAccuracyAnalyzer:
    """Scores pitch accuracy of played notes vs expected notes.

    A note is "correct" if the detected pitch is within tolerance_cents
    of the expected pitch.
    """

    def __init__(self, tolerance_cents: float = 50.0, a4: float = 440.0):
        self.tolerance_cents = tolerance_cents
        self.a4 = a4

    def analyze(self, detected_notes: list[dict],
                expected_notes: list[dict]) -> AccuracyReport:
        """Compare detected notes against expected notes.

        Args:
            detected_notes: list of {"time_s": float, "freq_hz": float, "confidence": float}
            expected_notes: list of {"time_s": float, "freq_hz": float}
                            Each must have a "freq_hz" field.

        Notes are matched by nearest time. Each expected note is matched
        to the closest detected note.

        Returns:
            AccuracyReport
        """
        if not detected_notes or not expected_notes:
            return AccuracyReport([], 0, 0, 0.0, 0.0, 0.0)

        results = []
        used_detected = set()

        for exp in expected_notes:
            exp_time = exp["time_s"]
            exp_freq = exp["freq_hz"]
            exp_name, exp_oct, _ = freq_to_note(exp_freq, self.a4)
            exp_label = f"{exp_name}{exp_oct}"

            # Find closest unused detected note by time
            best_idx = None
            best_dt = float("inf")
            for i, det in enumerate(detected_notes):
                if i in used_detected:
                    continue
                dt = abs(det["time_s"] - exp_time)
                if dt < best_dt:
                    best_dt = dt
                    best_idx = i

            if best_idx is None:
                continue

            used_detected.add(best_idx)
            det = detected_notes[best_idx]
            det_freq = det["freq_hz"]
            det_conf = det.get("confidence", 0.0)

            if det_freq <= 0:
                det_label = "—"
                cents = 0.0
                correct = False
            else:
                det_name, det_oct, _ = freq_to_note(det_freq, self.a4)
                det_label = f"{det_name}{det_oct}"
                cents = cents_between(exp_freq, det_freq)
                correct = abs(cents) <= self.tolerance_cents

            results.append(NoteResult(
                time_s=round(exp_time, 6),
                expected_note=exp_label,
                expected_freq_hz=round(exp_freq, 2),
                detected_note=det_label,
                detected_freq_hz=round(det_freq, 2),
                cents_deviation=round(cents, 2),
                is_correct=correct,
                confidence=round(det_conf, 4),
            ))

        correct_count = sum(1 for r in results if r.is_correct)
        total = len(results)
        deviations = [r.cents_deviation for r in results if r.detected_freq_hz > 0]

        return AccuracyReport(
            results=results,
            correct_count=correct_count,
            total_count=total,
            accuracy_pct=round(100.0 * correct_count / total, 1) if total > 0 else 0.0,
            mean_cents_deviation=round(sum(deviations) / len(deviations), 2) if deviations else 0.0,
            mean_abs_cents_deviation=round(
                sum(abs(c) for c in deviations) / len(deviations), 2
            ) if deviations else 0.0,
        )
