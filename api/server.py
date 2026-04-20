"""Flask REST API for the AI Guitar Coach.

Endpoints:
  GET  /api/results             — last analysis report
  POST /api/analyze             — analyze an uploaded WAV file
  GET  /api/profile             — fetch profile and streak info
  POST /api/profile             — update onboarding profile
"""

import time
import os
from pathlib import Path
import datetime

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from config import AppConfig
from main import analyze_wav_file
from database import db, User, Session, PerformanceMetric, AIFeedback, LearningState
from auth import require_auth
from flask import g
from payments import payments_bp

def create_api(config: AppConfig, static_dir: str | None = None) -> Flask:
    app = Flask(__name__, static_folder=static_dir, static_url_path="/")
    CORS(app)  # allow Vite dev server (localhost:5173)

    # Initialize SQLite Database
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///app.db'
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    db.init_app(app)
    
    with app.app_context():
        db.create_all()

    # Register Stripe Endpoints
    app.register_blueprint(payments_bp)

    results: dict = {}

    @app.route("/api/results")
    def get_results():
        return jsonify(results)

    @app.route("/api/profile", methods=["GET", "POST"])
    @require_auth
    def handle_profile():
        user_id = g.user_id
        user = User.query.get(user_id)
        if not user:
            user = User(user_id=user_id)
            db.session.add(user)
            db.session.commit()
            
        learning_state = user.learning_state
        if not learning_state:
            learning_state = LearningState(user_id=user_id)
            db.session.add(learning_state)
            db.session.commit()

        if request.method == "POST":
            data = request.json
            if not data:
                return jsonify({"error": "No data"}), 400
            user.skill_level = data.get("skill_level", user.skill_level)
            user.goal = data.get("goal", user.goal)
            user.language = data.get("language", user.language)
            
            # auto-generate a learning focus based on goal if they just onboarded
            if user.goal:
                learning_state.current_focus = f"Focus on improving your {user.goal}. Complete a daily session to build a habit."
                
            db.session.commit()

        return jsonify({
            "skill_level": user.skill_level,
            "goal": user.goal,
            "language": user.language,
            "streak_days": learning_state.streak_days,
            "current_focus": learning_state.current_focus
        })

    @app.route("/api/analyze", methods=["POST"])
    @require_auth
    def analyze_upload():
        """Analyze an uploaded WAV file from the browser."""
        nonlocal results
        
        # User & Usage Limit Enforcement
        user_id = g.user_id
        user = User.query.get(user_id)
        if not user:
            user = User(user_id=user_id)
            db.session.add(user)
            db.session.commit()
            
        if not user.can_analyze():
            return jsonify({"error": "LIMIT_REACHED"}), 403

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
            # 1. Update streak/learning state
            learning_state = user.learning_state
            if not learning_state:
                learning_state = LearningState(user_id=user.user_id)
                db.session.add(learning_state)
                
            today = datetime.date.today()
            if learning_state.last_practice_date != today:
                if learning_state.last_practice_date == today - datetime.timedelta(days=1):
                    learning_state.streak_days += 1
                elif learning_state.last_practice_date is None or learning_state.last_practice_date < today - datetime.timedelta(days=1):
                    learning_state.streak_days = 1 # Reset or start
                learning_state.last_practice_date = today

            # Get user context for AI prompt
            last_session = Session.query.filter_by(user_id=user.user_id).order_by(Session.timestamp.desc()).first()
            last_metrics = last_session.performance_metric if last_session else None
            
            ai_context = {
                "skill_level": user.skill_level or "beginner",
                "goal": user.goal or "general improvement",
                "language": user.language or "English",
                "last_timing_error": last_metrics.timing_error if last_metrics else None,
                "last_accuracy": last_metrics.pitch_accuracy if last_metrics else None
            }

            # Analyze
            report = analyze_wav_file(str(tmp), config, ai_context=ai_context)
            
            # Save Session to DB
            duration = report.get("duration", 0)
            new_session = Session(user_id=user.user_id, bpm=config.analysis.bpm, duration=duration)
            db.session.add(new_session)
            db.session.flush() # get ID
            
            metrics = PerformanceMetric(
                session_id=new_session.id,
                pitch_accuracy=report.get("accuracy_pct", 0),
                timing_error=report.get("timing_error_ms", 0),
                timing_consistency=report.get("timing_consistency", 0),
                dynamics_db=report.get("amplitude_db", 0)
            )
            db.session.add(metrics)
            
            ai_advice_dict = report.get("ai_advice", {})
            if isinstance(ai_advice_dict, str):
                import json
                try:
                    ai_advice_dict = json.loads(ai_advice_dict)
                except Exception:
                    ai_advice_dict = {"feedback": ai_advice_dict}

            # Make sure we don't break JS
            report["ai_advice"] = ai_advice_dict

            feedback_rec = AIFeedback(
                session_id=new_session.id,
                detailed_feedback=str(ai_advice_dict)
            )
            db.session.add(feedback_rec)

            # Record usage
            user.record_usage()
            db.session.commit()
            
            # Include streak info in response
            report["streak_days"] = learning_state.streak_days
            report["current_focus"] = learning_state.current_focus
            
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
