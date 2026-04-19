"""Flask + SocketIO web server for the AI Guitar Coach UI."""

import threading
import time
import numpy as np

from flask import Flask, send_from_directory, jsonify, request
from flask_socketio import SocketIO

from config import AppConfig
from audio.engine import AudioEngine
from dsp.pitch import yin_pitch
from dsp.onset import detect_onsets
from dsp.amplitude import rms_amplitude, rms_to_db
from dsp.note_utils import freq_to_note_string, freq_to_note
from analysis.timing import TimingAnalyzer
from analysis.error_detection import ErrorDetector
from feedback.engine import FeedbackEngine


def create_app(config: AppConfig) -> tuple[Flask, SocketIO]:
    """Create and configure the Flask application."""
    import os
    static_dir = os.path.join(os.path.dirname(__file__), "static")

    app = Flask(__name__, static_folder=static_dir)
    app.config["SECRET_KEY"] = "guitar-coach-dev"
    socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

    # Shared state
    engine = AudioEngine(config.audio)
    analysis_thread = None
    running = False

    # Analysis components
    timing_analyzer = TimingAnalyzer(tolerance_ms=config.analysis.timing_tolerance_ms)
    error_detector = ErrorDetector(
        late_threshold_ms=config.analysis.timing_tolerance_ms,
        unstable_std_ms=config.analysis.timing_unstable_std_ms,
    )
    feedback_engine = FeedbackEngine(error_detector)

    # Accumulate notes during a session
    session_notes = []
    session_onsets = []

    @app.route("/")
    def index():
        return send_from_directory(static_dir, "index.html")

    @app.route("/<path:path>")
    def static_files(path):
        return send_from_directory(static_dir, path)

    @app.route("/api/devices")
    def get_devices():
        import sounddevice as sd
        devices = sd.query_devices()
        # Deduplicate: on Windows, PortAudio lists the same physical device
        # under multiple host APIs (MME, DirectSound, WASAPI, WDM-KS).
        # We keep only one entry per device name, preferring WASAPI.
        seen_names = {}  # base_name -> device entry
        host_apis = sd.query_hostapis()

        for i, d in enumerate(devices):
            if d["max_input_channels"] <= 0:
                continue

            # Get the host API name for this device
            api_name = ""
            try:
                api_info = host_apis[d["hostapi"]]
                api_name = api_info["name"]
            except (IndexError, KeyError):
                pass

            # Clean the device name: PortAudio often appends the API name
            base_name = d["name"].strip()

            entry = {
                "index": i,
                "name": d["name"],
                "channels": d["max_input_channels"],
                "sample_rate": d["default_samplerate"],
                "api": api_name,
            }

            if base_name not in seen_names:
                seen_names[base_name] = entry
            else:
                # Prefer WASAPI over other APIs on Windows
                prev_api = seen_names[base_name].get("api", "")
                if "WASAPI" in api_name and "WASAPI" not in prev_api:
                    seen_names[base_name] = entry

        result = list(seen_names.values())
        return jsonify(result)

    @app.route("/api/start", methods=["POST"])
    def start_capture():
        nonlocal running, analysis_thread, session_notes, session_onsets

        if engine.is_running:
            return jsonify({"status": "already_running"})

        # Clear session state
        session_notes.clear()
        session_onsets.clear()

        # Optional: set device from request
        data = request.get_json(silent=True) or {}
        if "device" in data:
            config.audio.device_index = data["device"]
            engine.config.device_index = data["device"]
        if "bpm" in data:
            config.analysis.bpm = float(data["bpm"])

        engine.start()
        running = True

        # Start analysis loop in background
        analysis_thread = threading.Thread(
            target=_analysis_loop,
            args=(engine, config, socketio, session_notes, session_onsets,
                  timing_analyzer, feedback_engine, lambda: running),
            daemon=True,
        )
        analysis_thread.start()

        return jsonify({"status": "started"})

    @app.route("/api/stop", methods=["POST"])
    def stop_capture():
        nonlocal running
        running = False
        engine.stop()

        # Generate final session report
        if session_notes:
            onset_times = [n["time_s"] for n in session_notes]
            timing_report = timing_analyzer.analyze_vs_metronome(
                onset_times, config.analysis.bpm
            )
            from analysis.accuracy import PitchAccuracyAnalyzer
            acc_analyzer = PitchAccuracyAnalyzer(
                tolerance_cents=config.analysis.pitch_tolerance_cents,
                a4=config.reference_pitch_hz,
            )
            acc_report = acc_analyzer.analyze(session_notes, session_notes)
            avg_db = np.mean([n.get("db", -100) for n in session_notes]) if session_notes else -100

            report = feedback_engine.generate(
                timing=timing_report,
                accuracy=acc_report,
                detected_notes=session_notes,
                amplitude_db=float(avg_db),
            )
            socketio.emit("session_report", report.to_dict())

        return jsonify({"status": "stopped", "notes_detected": len(session_notes)})

    return app, socketio


def _analysis_loop(engine, config, socketio, session_notes, session_onsets,
                   timing_analyzer, feedback_engine, is_running):
    """Background thread: continuously analyze audio and emit results."""
    sr = config.audio.sample_rate
    frame_size = config.dsp.yin_frame_size
    analysis_interval = 0.05  # 50ms analysis rate
    session_start = time.time()

    while is_running():
        time.sleep(analysis_interval)

        available = engine.buffer.available()
        if available < frame_size:
            continue

        # Peek a frame for analysis (non-consuming = overlapping frames)
        frame = engine.peek_buffer(frame_size)
        if len(frame) < frame_size:
            continue

        # Consume only the new samples (hop), keeping overlap for next frame
        hop = config.dsp.yin_hop_size
        if available >= hop:
            engine.get_buffer(hop)  # consume hop_size worth of samples

        current_time = time.time() - session_start

        # Pitch detection
        freq, confidence = yin_pitch(
            frame, sr,
            fmin=config.dsp.fmin,
            fmax=config.dsp.fmax,
            threshold=config.dsp.yin_threshold,
        )

        # Amplitude
        rms = rms_amplitude(frame)
        db = rms_to_db(rms)

        # Build real-time update
        update = {
            "time_s": round(current_time, 3),
            "freq_hz": round(freq, 2),
            "confidence": round(confidence, 4),
            "note": freq_to_note_string(freq, config.reference_pitch_hz) if freq > 0 else "—",
            "rms": round(rms, 6),
            "db": round(db, 1),
            "is_silent": db < config.dsp.silence_threshold_db,
        }

        # Track notes when pitch is detected with good confidence
        if freq > 0 and confidence > 0.3 and db > config.dsp.silence_threshold_db:
            note_name, octave, cents = freq_to_note(freq, config.reference_pitch_hz)
            note_data = {
                "time_s": round(current_time, 3),
                "freq_hz": round(freq, 2),
                "confidence": round(confidence, 4),
                "note": f"{note_name}{octave}",
                "cents": round(cents, 1),
                "db": round(db, 1),
            }
            session_notes.append(note_data)
            update["detected_note"] = note_data

        # Emit real-time update
        socketio.emit("audio_update", update)

    print("[AnalysisLoop] Stopped")
