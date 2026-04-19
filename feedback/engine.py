"""Feedback engine — converts analysis results into structured reports and messages."""

from dataclasses import dataclass, field, asdict
import json

from analysis.timing import TimingReport
from analysis.accuracy import AccuracyReport
from analysis.error_detection import DetectedError, ErrorDetector


@dataclass
class FeedbackReport:
    """Complete feedback report for a playing session."""
    # Detected notes with pitch info
    notes: list[dict] = field(default_factory=list)

    # Timing metrics
    timing_error_ms: float = 0.0
    timing_std_ms: float = 0.0
    timing_consistency: float = 0.0
    on_time_ratio: float = 0.0

    # Pitch accuracy metrics
    pitch_error_cents: float = 0.0
    accuracy_pct: float = 0.0
    correct_notes: int = 0
    total_notes: int = 0

    # Average amplitude
    amplitude_db: float = -100.0

    # Detected errors
    errors: list[dict] = field(default_factory=list)

    # Human-readable feedback messages
    messages: list[str] = field(default_factory=list)

    # AI-generated custom advice 
    ai_advice: str = ""

    def to_json(self) -> str:
        """Serialize to pretty JSON."""
        return json.dumps(asdict(self), indent=2, ensure_ascii=False)

    def to_dict(self) -> dict:
        return asdict(self)


class FeedbackEngine:
    """Converts analysis metrics into a structured feedback report with messages."""

    def __init__(self, error_detector: ErrorDetector | None = None):
        self.error_detector = error_detector or ErrorDetector()

    def generate(self,
                 timing: TimingReport | None = None,
                 accuracy: AccuracyReport | None = None,
                 detected_notes: list[dict] | None = None,
                 amplitude_db: float | None = None) -> FeedbackReport:
        """Generate a complete feedback report.

        Args:
            timing: timing analysis results
            accuracy: pitch accuracy results
            detected_notes: raw detected notes list
            amplitude_db: average amplitude in dB

        Returns:
            FeedbackReport with metrics, errors, and messages.
        """
        report = FeedbackReport()

        # Fill in notes
        if detected_notes:
            report.notes = detected_notes

        # Fill in timing metrics
        if timing and timing.results:
            report.timing_error_ms = timing.mean_deviation_ms
            report.timing_std_ms = timing.std_deviation_ms
            report.timing_consistency = timing.consistency_score
            report.on_time_ratio = timing.on_time_ratio

        # Fill in accuracy metrics
        if accuracy and accuracy.results:
            report.pitch_error_cents = accuracy.mean_abs_cents_deviation
            report.accuracy_pct = accuracy.accuracy_pct
            report.correct_notes = accuracy.correct_count
            report.total_notes = accuracy.total_count

        # Fill in amplitude
        if amplitude_db is not None:
            report.amplitude_db = amplitude_db

        # Run error detection
        errors = self.error_detector.detect(
            timing or TimingReport([], 0, 0, 0, 0, 0),
            accuracy or AccuracyReport([], 0, 0, 0, 0, 0),
            amplitude_db,
        )

        report.errors = [
            {
                "type": e.error_type.value,
                "severity": e.severity.value,
                "message": e.message,
                "detail": e.detail,
            }
            for e in errors
        ]

        # Generate human-readable messages
        report.messages = self._generate_messages(timing, accuracy, errors, amplitude_db)

        return report

    def _generate_messages(self,
                           timing: TimingReport | None,
                           accuracy: AccuracyReport | None,
                           errors: list[DetectedError],
                           amplitude_db: float | None) -> list[str]:
        """Generate prioritised human-readable feedback messages."""
        messages = []

        # Lead with errors (most important first)
        for err in errors:
            messages.append(f"⚠ {err.message}")

        # Add positive feedback when things are going well
        if timing and timing.results:
            if timing.on_time_ratio >= 0.9:
                messages.append("✅ Excellent timing! Over 90% of notes were on time.")
            elif timing.on_time_ratio >= 0.7:
                messages.append(f"👍 Good timing — {timing.on_time_ratio:.0%} of notes on time.")

        if accuracy and accuracy.results:
            if accuracy.accuracy_pct >= 95:
                messages.append("✅ Near-perfect pitch accuracy!")
            elif accuracy.accuracy_pct >= 80:
                messages.append(f"👍 Good accuracy at {accuracy.accuracy_pct:.0f}%.")

        # Summary line
        if timing and accuracy and timing.results and accuracy.results:
            messages.append(
                f"📊 Summary: {accuracy.accuracy_pct:.0f}% accuracy, "
                f"timing consistency {timing.consistency_score:.0f}/100, "
                f"avg deviation {timing.mean_deviation_ms:+.0f}ms"
            )

        if not messages:
            messages.append("No notes detected — make sure your guitar signal is coming through.")

        return messages
