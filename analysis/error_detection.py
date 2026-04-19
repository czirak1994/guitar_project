"""Rule-based error detection engine."""

from dataclasses import dataclass
from enum import Enum
from analysis.timing import TimingReport
from analysis.accuracy import AccuracyReport


class ErrorType(Enum):
    LATE_PLAYING = "late_playing"
    EARLY_PLAYING = "early_playing"
    WRONG_NOTE = "wrong_note"
    UNSTABLE_TIMING = "unstable_timing"
    WEAK_DYNAMICS = "weak_dynamics"
    CONSISTENTLY_LATE = "consistently_late"
    CONSISTENTLY_EARLY = "consistently_early"
    LOW_ACCURACY = "low_accuracy"


class Severity(Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


@dataclass
class DetectedError:
    """A single detected playing error."""
    error_type: ErrorType
    severity: Severity
    message: str
    detail: str
    value: float  # the metric that triggered this error


class ErrorDetector:
    """Detects playing errors from timing and accuracy reports.

    Uses configurable thresholds to flag issues.
    """

    def __init__(self,
                 late_threshold_ms: float = 50.0,
                 early_threshold_ms: float = 50.0,
                 unstable_std_ms: float = 30.0,
                 low_accuracy_pct: float = 70.0,
                 weak_dynamics_db: float = -35.0):
        self.late_threshold_ms = late_threshold_ms
        self.early_threshold_ms = early_threshold_ms
        self.unstable_std_ms = unstable_std_ms
        self.low_accuracy_pct = low_accuracy_pct
        self.weak_dynamics_db = weak_dynamics_db

    def detect(self, timing: TimingReport,
               accuracy: AccuracyReport,
               amplitude_db: float | None = None) -> list[DetectedError]:
        """Run all error detection rules.

        Args:
            timing: timing analysis report
            accuracy: pitch accuracy report
            amplitude_db: average amplitude in dB (optional)

        Returns:
            List of detected errors, sorted by severity.
        """
        errors = []

        # --- Timing errors ---
        if timing.results:
            errors.extend(self._check_timing(timing))

        # --- Pitch accuracy errors ---
        if accuracy.results:
            errors.extend(self._check_accuracy(accuracy))

        # --- Dynamics errors ---
        if amplitude_db is not None:
            errors.extend(self._check_dynamics(amplitude_db))

        # Sort: ERROR > WARNING > INFO
        severity_order = {Severity.ERROR: 0, Severity.WARNING: 1, Severity.INFO: 2}
        errors.sort(key=lambda e: severity_order[e.severity])

        return errors

    def _check_timing(self, timing: TimingReport) -> list[DetectedError]:
        errors = []

        # Check for consistently late/early playing
        mean = timing.mean_deviation_ms
        if mean > self.late_threshold_ms:
            errors.append(DetectedError(
                error_type=ErrorType.CONSISTENTLY_LATE,
                severity=Severity.WARNING,
                message=f"You are consistently playing ~{mean:.0f}ms late",
                detail=f"Mean deviation: +{mean:.1f}ms across {len(timing.results)} notes",
                value=mean,
            ))
        elif mean < -self.early_threshold_ms:
            errors.append(DetectedError(
                error_type=ErrorType.CONSISTENTLY_EARLY,
                severity=Severity.WARNING,
                message=f"You are consistently playing ~{abs(mean):.0f}ms early",
                detail=f"Mean deviation: {mean:.1f}ms across {len(timing.results)} notes",
                value=mean,
            ))

        # Check for unstable timing
        if timing.std_deviation_ms > self.unstable_std_ms:
            errors.append(DetectedError(
                error_type=ErrorType.UNSTABLE_TIMING,
                severity=Severity.WARNING,
                message="Your timing is inconsistent — try a slower tempo",
                detail=f"Timing std dev: {timing.std_deviation_ms:.1f}ms "
                       f"(consistency score: {timing.consistency_score:.0f}/100)",
                value=timing.std_deviation_ms,
            ))

        # Flag individual late/early notes
        late_count = sum(1 for r in timing.results if r.is_late)
        early_count = sum(1 for r in timing.results if r.is_early)
        total = len(timing.results)

        if late_count > total * 0.3:
            errors.append(DetectedError(
                error_type=ErrorType.LATE_PLAYING,
                severity=Severity.INFO,
                message=f"{late_count}/{total} notes were played late",
                detail=f"{late_count} notes exceeded +{self.late_threshold_ms:.0f}ms threshold",
                value=late_count,
            ))

        if early_count > total * 0.3:
            errors.append(DetectedError(
                error_type=ErrorType.EARLY_PLAYING,
                severity=Severity.INFO,
                message=f"{early_count}/{total} notes were played early",
                detail=f"{early_count} notes exceeded -{self.early_threshold_ms:.0f}ms threshold",
                value=early_count,
            ))

        return errors

    def _check_accuracy(self, accuracy: AccuracyReport) -> list[DetectedError]:
        errors = []

        # Wrong notes
        wrong_count = accuracy.total_count - accuracy.correct_count
        if wrong_count > 0:
            sev = Severity.ERROR if accuracy.accuracy_pct < 50 else Severity.WARNING
            errors.append(DetectedError(
                error_type=ErrorType.WRONG_NOTE,
                message=f"{wrong_count}/{accuracy.total_count} notes were incorrect",
                severity=sev,
                detail=f"Pitch accuracy: {accuracy.accuracy_pct:.0f}%, "
                       f"mean absolute deviation: {accuracy.mean_abs_cents_deviation:.0f} cents",
                value=wrong_count,
            ))

        # Overall low accuracy
        if accuracy.accuracy_pct < self.low_accuracy_pct:
            errors.append(DetectedError(
                error_type=ErrorType.LOW_ACCURACY,
                severity=Severity.ERROR,
                message=f"Note accuracy is {accuracy.accuracy_pct:.0f}% — focus on correct fingering",
                detail=f"Target: >{self.low_accuracy_pct:.0f}%. "
                       f"Mean deviation: {accuracy.mean_abs_cents_deviation:.0f} cents",
                value=accuracy.accuracy_pct,
            ))

        return errors

    def _check_dynamics(self, amplitude_db: float) -> list[DetectedError]:
        errors = []

        if amplitude_db < self.weak_dynamics_db:
            errors.append(DetectedError(
                error_type=ErrorType.WEAK_DYNAMICS,
                severity=Severity.INFO,
                message="Your playing is very quiet — try picking harder",
                detail=f"Average amplitude: {amplitude_db:.1f} dB "
                       f"(threshold: {self.weak_dynamics_db:.1f} dB)",
                value=amplitude_db,
            ))

        return errors
