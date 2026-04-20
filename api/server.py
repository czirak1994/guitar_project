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
import threading
import json

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

    # Initialize Database (PostgreSQL if DATABASE_URL, else SQLite)
    database_url = os.getenv('DATABASE_URL')
    if database_url:
        app.config['SQLALCHEMY_DATABASE_URI'] = database_url.replace("postgres://", "postgresql://", 1)  # SQLAlchemy 1.4+ fix
    else:
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

            # Analyze (run_ai=False ensures we don't block the request; AI is handled in background thread)
            report = analyze_wav_file(str(tmp), config, ai_context=ai_context, run_ai=False)
            
            # Save Session to DB
            duration = report.get("duration", 0)
            backing_track_url = request.form.get("backing_track_url")
            new_session = Session(user_id=user.user_id, bpm=config.analysis.bpm, duration=duration, backing_track_url=backing_track_url)
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
            
            # Record usage
            user.record_usage()
            db.session.commit()
            
            # Start Async AI
            def run_async_ai(app_clone, sess_id, wave_path, cfg, rep, cxt, bt_url):
                with app_clone.app_context():
                    bt_path = None
                    if bt_url and bt_url.startswith('/api/audio/'):
                        bt_filename = bt_url.split('/')[-1]
                        potential_path = os.path.join(os.environ.get("TEMP", "/tmp"), bt_filename)
                        if os.path.exists(potential_path):
                            bt_path = potential_path
                            print(f"[Async] Found backing track at {bt_path}")

                    try:
                        from feedback.ai_coach import AICoach
                        coach = AICoach(cfg.ai)
                        if cfg.ai.enabled:
                            ai_advice = coach.evaluate_audio(wave_path, rep, cfg.analysis.bpm, cxt, bt_path)
                        else:
                            ai_advice = coach._fallback(rep)
                        
                        s = Session.query.get(sess_id)
                        if s:
                            s.ai_status = 'completed'
                            fb = AIFeedback(session_id=sess_id, detailed_feedback=json.dumps(ai_advice))
                            db.session.add(fb)
                            db.session.commit()
                    except Exception as e:
                        print(f"[Async AI] Error: {e}")
                        s = Session.query.get(sess_id)
                        if s:
                            s.ai_status = 'failed'
                            db.session.commit()
                    finally:
                        try:
                            os.remove(wave_path)
                        except Exception:
                            pass

            app_clone = app
            t = threading.Thread(target=run_async_ai, args=(app_clone, new_session.id, str(tmp), config, report, ai_context, backing_track_url))
            t.start()

            return jsonify({
                "session_id": new_session.id,
                "status": "processing_ai",
                "accuracy_pct": report.get("accuracy_pct"),
                "bpm": config.analysis.bpm,
                "streak_days": learning_state.streak_days,
                "current_focus": learning_state.current_focus
            })

        except Exception as exc:
            return jsonify({"error": str(exc)}), 500
        # tmp file removed in async thread

    @app.route("/api/session/<int:session_id>", methods=["GET"])
    @require_auth
    def get_session(session_id):
        session = Session.query.get_or_404(session_id)
        if session.user_id != g.user_id:
            return jsonify({"error": "Unauthorized"}), 403
            
        metrics = session.performance_metric
        ai_fb = session.ai_feedback
        
        advice = None
        if ai_fb and ai_fb.detailed_feedback:
            try:
                advice = json.loads(ai_fb.detailed_feedback)
            except Exception:
                pass

        return jsonify({
            "id": session.id,
            "ai_status": session.ai_status,
            "accuracy_pct": metrics.pitch_accuracy if metrics else 0,
            "bpm": session.bpm,
            "ai_advice": advice
        })

    @app.route("/api/yt/extract", methods=["POST"])
    @require_auth
    def extract_yt():
        url = request.json.get("url")
        if not url: return jsonify({"error": "URL required"}), 400
        
        try:
            from api.yt import get_youtube_audio
            temp_dir = os.environ.get("TEMP", "/tmp")
            res = get_youtube_audio(url, temp_dir)
            filename = os.path.basename(res["filepath"])
            return jsonify({"audio_url": f"/api/audio/{filename}", "title": res["title"]})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/api/audio/<filename>", methods=["GET"])
    def serve_audio(filename):
        temp_dir = os.environ.get("TEMP", "/tmp")
        return send_from_directory(temp_dir, filename)

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
