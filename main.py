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


def analyze_wav_file(filepath: str, config: AppConfig) -> dict:
    """Analyze a WAV file offline and return the feedback report as dict."""
    import soundfile as sf
    from dsp.pitch import yin_pitch_track
    from dsp.onset import detect_onsets
    from dsp.amplitude import amplitude_envelope, rms_amplitude, rms_to_db
    from dsp.note_utils import freq_to_note_string
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

    # --- Pitch detection ---
    print("Running pitch detection (YIN)...")
    pitch_results = yin_pitch_track(
        signal, sr,
        frame_size=config.dsp.yin_frame_size,
        hop_size=config.dsp.yin_hop_size,
        fmin=config.dsp.fmin,
        fmax=config.dsp.fmax,
        threshold=config.dsp.yin_threshold,
    )

    # Filter to voiced frames only
    voiced = [p for p in pitch_results if p["freq_hz"] > 0 and p["confidence"] > 0.5]
    print(f"  Detected {len(voiced)} voiced frames out of {len(pitch_results)} total")

    # --- Onset detection ---
    print("Running onset detection...")
    onsets = detect_onsets(
        signal, sr,
        hop_size=config.dsp.onset_hop_size,
        threshold=config.dsp.onset_threshold,
        min_interval_ms=config.dsp.min_onset_interval_ms,
    )
    print(f"  Detected {len(onsets)} note onsets")

    # --- Build detected notes (pitch at each onset) ---
    detected_notes = []
    for onset in onsets:
        onset_time = onset["time_s"]
        # Find the closest pitched frame to this onset
        best = None
        best_dt = float("inf")
        for pf in voiced:
            dt = abs(pf["time_s"] - onset_time)
            if dt < best_dt:
                best_dt = dt
                best = pf
        if best and best_dt < 0.1:  # within 100ms
            note_str = freq_to_note_string(best["freq_hz"], config.reference_pitch_hz)
            detected_notes.append({
                "time_s": onset_time,
                "freq_hz": best["freq_hz"],
                "confidence": best["confidence"],
                "note": note_str,
                "onset_strength": onset["strength"],
            })

    print(f"  Matched {len(detected_notes)} notes to onsets")

    # --- Amplitude ---
    print("Computing amplitude...")
    avg_rms = rms_amplitude(signal)
    avg_db = rms_to_db(avg_rms)
    print(f"  Average RMS: {avg_rms:.4f} ({avg_db:.1f} dB)")

    # --- Timing analysis (vs metronome grid) ---
    latency_s = config.audio.latency_offset_ms / 1000.0
    print(f"Analyzing timing at {config.analysis.bpm} BPM... (latency offset: {config.audio.latency_offset_ms:.0f}ms)")
    onset_times = [n["time_s"] - latency_s for n in detected_notes]
    timing_analyzer = TimingAnalyzer(tolerance_ms=config.analysis.timing_tolerance_ms)
    timing_report = timing_analyzer.analyze_vs_metronome(
        onset_times, config.analysis.bpm, auto_align=True
    )

    # --- Pitch accuracy (if expected notes provided) ---
    # For offline MVP, we compare detected notes against themselves
    # (self-consistency check). In practice, user provides expected sequence.
    accuracy_analyzer = PitchAccuracyAnalyzer(
        tolerance_cents=config.analysis.pitch_tolerance_cents,
        a4=config.reference_pitch_hz,
    )

    # For now, create a simple accuracy report from detected notes
    # (In Phase 2, this will compare against a reference MIDI/sequence)
    accuracy_report = accuracy_analyzer.analyze(
        detected_notes,
        detected_notes,  # comparing against self = 100% accuracy baseline
    )

    # --- Error detection ---
    print("Running error detection...")
    error_detector = ErrorDetector(
        late_threshold_ms=config.analysis.timing_tolerance_ms,
        early_threshold_ms=config.analysis.timing_tolerance_ms,
        unstable_std_ms=config.analysis.timing_unstable_std_ms,
        low_accuracy_pct=70.0,
        weak_dynamics_db=config.analysis.weak_dynamics_db,
    )

    # --- Feedback ---
    print("Generating feedback...")
    feedback_engine = FeedbackEngine(error_detector)
    report = feedback_engine.generate(
        timing=timing_report,
        accuracy=accuracy_report,
        detected_notes=detected_notes,
        amplitude_db=avg_db,
    )
    
    report_dict = report.to_dict()

    from feedback.ai_coach import AICoach
    if config.ai.enabled:
        print("Running AI Audio Coach analysis...")
        coach = AICoach(config.ai)
        report_dict["ai_advice"] = coach.evaluate_audio(filepath, report_dict, config.analysis.bpm)
    else:
        # Fallback if disabled
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
