"""AI Guitar Coach — main entry point.

Usage:
    python main.py --record                 # Record (Enter to stop, max 30s) then analyze
    python main.py --record --duration 15   # Same but max 15s
    python main.py --offline recording.wav  # Analyze an existing WAV file
    python main.py --list-devices           # List audio devices
"""

import argparse
import sys
import json
import numpy as np

# Force UTF-8 output on Windows (avoids cp1250 charmap errors with emoji)
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if sys.stderr.encoding and sys.stderr.encoding.lower() != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from config import AppConfig, AudioConfig, DSPConfig, AnalysisConfig


# ── Scale parsing ──────────────────────────────────────────────────────────────

_SCALE_INTERVALS = {
    'major':           [0, 2, 4, 5, 7, 9, 11],
    'minor':           [0, 2, 3, 5, 7, 8, 10],
    'pentatonic':      [0, 2, 4, 7, 9],
    'minor pentatonic':[0, 3, 5, 7, 10],
    'blues':           [0, 3, 5, 6, 7, 10],
    'dorian':          [0, 2, 3, 5, 7, 9, 10],
    'mixolydian':      [0, 2, 4, 5, 7, 9, 10],
}
_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
_FLAT_MAP   = {'Db': 'C#', 'Eb': 'D#', 'Fb': 'E',  'Gb': 'F#',
               'Ab': 'G#', 'Bb': 'A#', 'Cb': 'B'}


def _parse_scale_notes(scale_or_key: str) -> list[str] | None:
    """Parse a scale/key string like 'C major', 'G minor', 'A pentatonic'.

    Returns a list of note name strings, or None if the string is unrecognisable.
    """
    if not scale_or_key:
        return None
    parts = scale_or_key.strip().split()
    if not parts:
        return None

    root_raw = parts[0].capitalize()
    root = _FLAT_MAP.get(root_raw, root_raw)
    if root not in _NOTE_NAMES:
        return None

    scale_type = ' '.join(p.lower() for p in parts[1:]) if len(parts) > 1 else 'major'
    intervals  = _SCALE_INTERVALS.get(scale_type) or _SCALE_INTERVALS.get(scale_type.split()[0])
    if intervals is None:
        # Unknown scale type — at least return all 12 notes so nothing is "wrong"
        return None

    root_idx = _NOTE_NAMES.index(root)
    return [_NOTE_NAMES[(root_idx + interval) % 12] for interval in intervals]


# ── Legacy note detection (no aubio) ─────────────────────────────────────────

def _detect_notes_legacy(signal, sr, config, latency_ms: float = 0.0) -> list[dict]:
    """Pure-numpy YIN + spectral-flux onset detection (fallback if aubio missing)."""
    from dsp.pitch import yin_pitch_track
    from dsp.onset import detect_onsets
    from dsp.note_utils import freq_to_note

    latency_s = latency_ms / 1000.0

    pitch_results = yin_pitch_track(
        signal, sr,
        frame_size=config.dsp.yin_frame_size,
        hop_size=config.dsp.yin_hop_size,
        fmin=config.dsp.fmin,
        fmax=config.dsp.fmax,
        threshold=config.dsp.yin_threshold,
    )
    voiced = [p for p in pitch_results if p["freq_hz"] > 0 and p["confidence"] > 0.3]

    onsets = detect_onsets(
        signal, sr,
        hop_size=config.dsp.onset_hop_size,
        threshold=config.dsp.onset_threshold,
        min_interval_ms=config.dsp.min_onset_interval_ms,
    )

    detected_notes = []
    used = set()
    for onset in onsets:
        onset_time = onset["time_s"]
        best, best_score, best_idx = None, float("inf"), -1
        for idx, pf in enumerate(voiced):
            if idx in used:
                continue
            dt = pf["time_s"] - onset_time
            if -0.05 <= dt <= 0.25 and abs(dt) < best_score:
                best_score, best, best_idx = abs(dt), pf, idx
        if best is not None:
            used.add(best_idx)
            note_name, octave, cents = freq_to_note(best["freq_hz"], config.reference_pitch_hz)
            detected_notes.append({
                "time_s":    round(onset_time - latency_s, 3),
                "freq_hz":   round(best["freq_hz"], 2),
                "confidence":round(best["confidence"], 3),
                "note":      f"{note_name}{octave}",
                "note_name": note_name,
                "cents":     round(cents, 1),
                "start_ms":  round((onset_time - latency_s) * 1000, 1),
                "duration_ms": 0.0,
                "pitch_hz":  round(best["freq_hz"], 2),
                "scale_status": "correct",
                "beat_offset_ms": 0.0,
                "beat_time_s": 0.0,
                "timing": "on",
            })
        else:
            detected_notes.append({
                "time_s":    round(onset_time - latency_s, 3),
                "freq_hz":   0.0,
                "confidence":0.0,
                "note":      "?",
                "note_name": "?",
                "cents":     None,
                "start_ms":  round((onset_time - latency_s) * 1000, 1),
                "duration_ms": 0.0,
                "pitch_hz":  0.0,
                "scale_status": "correct",
                "beat_offset_ms": 0.0,
                "beat_time_s": 0.0,
                "timing": "on",
            })
    return detected_notes


def analyze_wav_file(filepath: str, config: AppConfig, ai_context: dict = None, run_ai: bool = True) -> dict:
    """Analyze a WAV file and return the feedback report as dict.

    Note detection uses aubio (YIN pitch + onset detection) for accuracy.
    Falls back to the legacy pure-numpy YIN pipeline if aubio is not installed.
    """
    import soundfile as sf
    from dsp.amplitude import amplitude_envelope, rms_amplitude, rms_to_db
    from dsp.note_utils import freq_to_note_string, freq_to_note
    from analysis.timing import TimingAnalyzer
    from analysis.accuracy import PitchAccuracyAnalyzer
    from analysis.error_detection import ErrorDetector
    from feedback.engine import FeedbackEngine

    # Load audio
    print(f"Loading: {filepath}")
    signal, sr = sf.read(filepath, dtype="float32")

    # Convert to mono if stereo
    if signal.ndim > 1:
        signal = signal[:, 0]

    print(f"  Duration: {len(signal)/sr:.2f}s, Sample rate: {sr} Hz, Samples: {len(signal)}")

    # --- Note detection (aubio) ---
    scale_notes = None
    if ai_context:
        raw_scale = ai_context.get('scale_or_key', '') or ''
        if raw_scale:
            scale_notes = _parse_scale_notes(raw_scale)

    latency_ms = config.audio.latency_offset_ms

    try:
        from dsp.aubio_notes import detect_notes_aubio
        print("Running note detection (aubio YIN + onset)...")
        detected_notes = detect_notes_aubio(
            signal, sr,
            bpm=config.analysis.bpm,
            scale_notes=scale_notes,
            a4=config.reference_pitch_hz,
            latency_ms=latency_ms,
        )
        print(f"  Detected {len(detected_notes)} notes")
    except RuntimeError as exc:
        # aubio not installed — fall back to legacy pipeline
        print(f"  [WARNING] {exc} — falling back to legacy YIN+spectral-flux")
        detected_notes = _detect_notes_legacy(signal, sr, config, latency_ms)

    # --- Amplitude ---
    print("Computing amplitude...")
    avg_rms = rms_amplitude(signal)
    avg_db = rms_to_db(avg_rms)
    print(f"  Average RMS: {avg_rms:.4f} ({avg_db:.1f} dB)")

    # --- Timing analysis (vs metronome grid) ---
    latency_s = latency_ms / 1000.0
    print(f"Analyzing timing at {config.analysis.bpm} BPM...")
    onset_times = [n["time_s"] for n in detected_notes]
    timing_analyzer = TimingAnalyzer(tolerance_ms=config.analysis.timing_tolerance_ms)
    timing_report = timing_analyzer.analyze_vs_metronome(
        onset_times, config.analysis.bpm, auto_align=True
    )

    # Sync beat_offset_ms / beat_time_s from the timing report so aubio and
    # legacy paths both produce identical fields.
    for note, tr in zip(detected_notes, timing_report.results):
        note["beat_offset_ms"] = round(tr.deviation_ms, 1)
        note["beat_time_s"]    = round(tr.expected_time_s, 3)

    # --- Metronome leak check ---
    metronome_leak_warning = None
    if len(timing_report.results) > 4:
        devs = [abs(r.deviation_ms) for r in timing_report.results]
        if float(np.std(devs)) < 5.0 and float(np.mean(devs)) < 8.0:
            metronome_leak_warning = (
                "⚠ Metronome leak detected: onset jitter is suspiciously low "
                f"(std={np.std(devs):.1f} ms, mean={np.mean(devs):.1f} ms). "
                "The microphone may be capturing the click track from speakers. "
                "Fix: use headphones, or route the metronome to a separate output."
            )
            print(f"  [WARNING] {metronome_leak_warning}")

    # --- Pitch accuracy ---
    accuracy_analyzer = PitchAccuracyAnalyzer(
        tolerance_cents=config.analysis.pitch_tolerance_cents,
        a4=config.reference_pitch_hz,
    )
    accuracy_report = accuracy_analyzer.analyze(detected_notes, detected_notes)

    # --- Error detection + feedback ---
    print("Running error detection...")
    error_detector = ErrorDetector(
        late_threshold_ms=config.analysis.timing_tolerance_ms,
        early_threshold_ms=config.analysis.timing_tolerance_ms,
        unstable_std_ms=config.analysis.timing_unstable_std_ms,
        low_accuracy_pct=70.0,
        weak_dynamics_db=config.analysis.weak_dynamics_db,
    )
    print("Generating feedback...")
    feedback_engine = FeedbackEngine(error_detector)
    report = feedback_engine.generate(
        timing=timing_report,
        accuracy=accuracy_report,
        detected_notes=detected_notes,
        amplitude_db=avg_db,
    )

    report_dict = report.to_dict()
    report_dict["detected_notes"]  = detected_notes
    report_dict["duration_s"]      = round(len(signal) / sr, 3)
    report_dict["phase_offset_ms"] = timing_report.phase_offset_ms
    report_dict["timing_stats"]    = {
        "mean_error_ms":   round(timing_report.mean_deviation_ms, 1),
        "std_ms":          round(timing_report.std_deviation_ms, 1),
        "on_time_ratio":   round(timing_report.on_time_ratio, 3),
        "consistency":     round(timing_report.consistency_score, 1),
    }
    report_dict["pitch_stats"] = {
        "note_count":   len(detected_notes),
        "scale_notes":  scale_notes or [],
        "wrong_count":  sum(1 for n in detected_notes if n.get('scale_status') == 'wrong'),
        "close_count":  sum(1 for n in detected_notes if n.get('scale_status') == 'close'),
        "correct_count": sum(1 for n in detected_notes if n.get('scale_status') == 'correct'),
    }
    if metronome_leak_warning:
        report_dict["metronome_leak_warning"] = metronome_leak_warning

    from feedback.ai_coach import AICoach
    if run_ai:
        if config.ai.enabled:
            print("Running AI Audio Coach analysis...")
            coach = AICoach(config.ai)
            report_dict["ai_advice"] = coach.evaluate_audio(filepath, report_dict, config.analysis.bpm, ai_context)
        else:
            coach = AICoach(config.ai)
            report_dict["ai_advice"] = coach._fallback(report_dict)

    return report_dict


def list_devices():
    """Print available audio devices."""
    import sounddevice as sd
    print("\n=== Available Audio Devices ===\n")
    print(sd.query_devices())
    print(f"\nDefault input device: {sd.default.device[0]}")
    print(f"Default output device: {sd.default.device[1]}")


def print_report(result: dict):
    """Pretty-print the analysis report and coaching advice to the terminal."""
    from feedback.ai_coach import AICoach
    from config import AIConfig

    sep = "=" * 60
    print(f"\n{sep}")
    print("📊  ANALYSIS REPORT")
    print(sep)

    notes = result.get("notes", [])
    print(f"  Notes detected   : {len(notes)}")
    print(f"  Avg amplitude    : {result.get('amplitude_db', -100):.1f} dB")
    print(f"  Pitch accuracy   : {result.get('accuracy_pct', 0):.1f}%")
    print(f"  Timing error     : {result.get('timing_error_ms', 0):+.1f} ms (mean)")
    print(f"  Timing std-dev   : {result.get('timing_std_ms', 0):.1f} ms")
    print(f"  On-time ratio    : {result.get('on_time_ratio', 0):.0%}")
    print(f"  Consistency score: {result.get('timing_consistency', 0):.0f}/100")

    errors = result.get("errors", [])
    if errors:
        print(f"\n  ⚡ Detected issues ({len(errors)}):")
        for e in errors:
            icon = "🔴" if e["severity"] == "high" else ("🟡" if e["severity"] == "medium" else "🟢")
            print(f"    {icon} [{e['type']}] {e['message']}")
            if e.get("detail"):
                print(f"        {e['detail']}")

    # Note list (first 10)
    if notes:
        print(f"\n  🎵 Notes played (first {min(len(notes), 10)} of {len(notes)}):")
        for n in notes[:10]:
            print(f"    {n.get('note', '?'):>4}  {n.get('freq_hz', 0):7.2f} Hz  "
                  f"conf={n.get('confidence', 0):.2f}  @ {n.get('time_s', 0):.2f}s")

    print(f"\n{sep}")
    print("🤖  COACHING ADVICE")
    print(sep)

    # Display AI or rule-based advice
    advice = result.get("ai_advice", "")
    if advice:
        print(advice)
    else:
        print("No coaching advice available.")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="AI Guitar Coach — record and analyze your guitar playing"
    )
    parser.add_argument("--record", action="store_true",
                        help="Record audio (press Enter to stop) then analyze")
    parser.add_argument("--duration", type=float, default=30.0,
                        help="Max recording duration in seconds (default: 30)")
    parser.add_argument("--offline", type=str, metavar="WAV_FILE",
                        help="Analyze an existing WAV file")
    parser.add_argument("--list-devices", action="store_true",
                        help="List available audio devices")
    parser.add_argument("--web", action="store_true",
                        help="Start the web API server (use with npm run dev in frontend/)")
    parser.add_argument("--port", type=int, default=5000,
                        help="Port for the web API server (default: 5000)")
    parser.add_argument("--bpm", type=float, default=120.0,
                        help="Tempo in BPM for timing analysis (default: 120)")
    parser.add_argument("--device", type=int, default=None,
                        help="Audio device index (use --list-devices to find)")

    args = parser.parse_args()

    config = AppConfig()
    config.analysis.bpm = args.bpm
    if args.device is not None:
        config.audio.device_index = args.device

    if args.list_devices:
        list_devices()
        return

    if args.record:
        from audio.recorder import record_to_wav
        print(f"\n🎸 AI Guitar Coach — Record Mode  (BPM: {config.analysis.bpm})")
        wav_path = None
        try:
            wav_path = record_to_wav(
                max_duration_s=args.duration,
                sample_rate=config.audio.sample_rate,
                channels=config.audio.channels,
                device_index=config.audio.device_index,
                block_size=config.audio.block_size,
            )
            import sys as _sys, time as _time
            _sys.stdout.flush()
            _time.sleep(0.15)  # let recorder thread finish its last counter print
            print("\n" + "-" * 60)
            print("🔍  Analyzing...")
            result = analyze_wav_file(str(wav_path), config)
            print_report(result)
        finally:
            if wav_path and wav_path.exists():
                wav_path.unlink()
                print(f"🗑   Temp file deleted: {wav_path.name}")
        return

    if args.offline:
        print(f"\n🎸 AI Guitar Coach — Offline Mode  (BPM: {config.analysis.bpm})")
        result = analyze_wav_file(args.offline, config)
        print_report(result)
        return

    if args.web:
        from api.server import create_api
        print(f"\n[AI Guitar Coach] Web Mode")
        print(f"   API server -> http://localhost:{args.port}")
        print(f"   Frontend   -> run  npm run dev  in the frontend/ directory")
        print(f"   Then open  http://localhost:5173  in your browser\n")
        import os
        static_dir = os.path.join(os.path.dirname(__file__), "frontend", "dist")
        if not os.path.exists(static_dir):
            static_dir = None
            
        app = create_api(config, static_dir=static_dir)
        app.run(host="0.0.0.0", port=args.port, threaded=True, debug=False)
        return

    # No mode specified
    parser.print_help()
    print("\n💡 Tips:")
    print("   python main.py --record     → CLI recording session")
    print("   python main.py --web        → start web API (use with React frontend)")


if __name__ == "__main__":
    main()
