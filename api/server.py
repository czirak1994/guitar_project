"""Flask REST API for the AI Guitar Coach.

Endpoints:
  GET  /api/results             — last analysis report
  POST /api/analyze             — analyze an uploaded WAV file
"""

import time
import os
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from config import AppConfig
from main import analyze_wav_file


def create_api(config: AppConfig, static_dir: str | None = None) -> Flask:
    app = Flask(__name__, static_folder=static_dir, static_url_path="/")
    CORS(app)  # allow Vite dev server (localhost:5173)

    results: dict = {}

    @app.route("/api/results")
    def get_results():
        return jsonify(results)

    @app.route("/api/analyze", methods=["POST"])
    def analyze_upload():
        """Analyze an uploaded WAV file from the browser."""
        nonlocal results
        if "file" not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
        
        # Override config dynamically based on form data
        bpm = request.form.get("bpm")
        if bpm:
            try:
                config.analysis.bpm = float(bpm)
            except ValueError:
                pass
            
        latency_ms = request.form.get("latency_ms")
        if latency_ms:
            try:
                config.audio.latency_offset_ms = float(latency_ms)
            except ValueError:
                pass

        f = request.files["file"]
        # In a cloud environment, use fallback to /tmp or Windows TEMP
        temp_dir = os.environ.get("TEMP", "/tmp")
        tmp = Path(os.path.join(temp_dir, f"upload_{int(time.time()*1000)}.wav"))
        f.save(tmp)
        
        try:
            report = analyze_wav_file(str(tmp), config)
            results = report
            return jsonify(report)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass

    # ── Serve React build (production) ───────────────────────────────────────
    if static_dir:
        @app.route("/", defaults={"path": ""})
        @app.route("/<path:path>")
        def serve_react(path):
            full = os.path.join(static_dir, path)
            if path and os.path.exists(full):
                return send_from_directory(static_dir, path)
            return send_from_directory(static_dir, "index.html")

    return app
