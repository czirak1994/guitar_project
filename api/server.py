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
from database import db, User, GuestUser, Session, PerformanceMetric, AIFeedback, LearningState, DeveloperFeedback, ChatMessage
from auth import require_auth, optional_auth, get_client_ip
from flask import g, make_response
from payments import payments_bp

# Cookie config: prod uses secure=True; dev (no DATABASE_URL) leaves it False.
_COOKIE_SECURE = bool(os.getenv('DATABASE_URL'))
_COOKIE_MAX_AGE = 60 * 60 * 24 * 365  # 1 year


def _get_or_create_guest() -> GuestUser:
    """Lookup or create a GuestUser based on g.guest_id (set by optional_auth)."""
    guest = GuestUser.query.get(g.guest_id)
    if not guest:
        guest = GuestUser(
            anon_token=g.guest_id,
            ip_address=get_client_ip(),
            usage_count=0,
            last_usage_date=datetime.date.today(),
        )
        db.session.add(guest)
        db.session.commit()
    return guest


def _attach_guest_cookie(resp):
    """Attach anon_token cookie to response if a new guest token was just generated."""
    if getattr(g, 'is_new_guest', False) and getattr(g, 'guest_id', None):
        resp.set_cookie(
            'anon_token',
            g.guest_id,
            max_age=_COOKIE_MAX_AGE,
            httponly=True,
            samesite='Lax',
            secure=_COOKIE_SECURE,
        )
    return resp

def _normalize_ai_payload(ai_advice: dict | None) -> tuple[dict | None, dict | None]:
    if not isinstance(ai_advice, dict):
        return ai_advice, None

    payload = dict(ai_advice)
    meta = payload.pop("_meta", None)
    return payload, meta if isinstance(meta, dict) else None

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
        # ── Runtime column migrations ─────────────────────────────────────────
        # db.create_all() does not ADD new columns to existing tables.
        # We use raw SQL ALTER TABLE ... ADD COLUMN IF NOT EXISTS to safely
        # add new columns without destroying existing data.
        try:
            with db.engine.connect() as conn:
                conn.execute(db.text(
                    "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR"
                ))
                conn.execute(db.text(
                    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS problem VARCHAR"
                ))
                conn.execute(db.text(
                    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS focus VARCHAR"
                ))
                conn.execute(db.text(
                    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS style VARCHAR"
                ))
                conn.execute(db.text(
                    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS guest_token VARCHAR"
                ))
                # Make user_id nullable on existing tables
                try:
                    conn.execute(db.text(
                        "ALTER TABLE sessions ALTER COLUMN user_id DROP NOT NULL"
                    ))
                except Exception:
                    pass
                conn.commit()
                print("[DB] Migration: stripe_customer_id, problem, focus, style, guest_token columns ensured.")
        except Exception as migration_err:
            # SQLite doesn't support IF NOT EXISTS on ALTER TABLE
            # but it's fine — it will fail silently on SQLite dev env
            print(f"[DB] Migration note (likely SQLite dev): {migration_err}")

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
            "plan": user.plan,
            "streak_days": learning_state.streak_days,
            "current_focus": learning_state.current_focus
        })

    @app.route("/api/stats", methods=["GET"])
    @require_auth
    def get_stats():
        """Return aggregated practice statistics for the profile page."""
        user_id = g.user_id
        user = User.query.get(user_id)
        if not user:
            return jsonify({"total_sessions": 0, "best_accuracy": None, "member_since": None})

        sessions = Session.query.filter_by(user_id=user_id).all()
        total = len(sessions)

        best_acc = None
        for s in sessions:
            if s.performance_metric and s.performance_metric.pitch_accuracy is not None:
                v = s.performance_metric.pitch_accuracy
                if best_acc is None or v > best_acc:
                    best_acc = v

        # Earliest session date
        member_since = None
        if sessions:
            earliest = min(sessions, key=lambda s: s.timestamp)
            member_since = earliest.timestamp.strftime("%b %Y")

        return jsonify({
            "total_sessions": total,
            "best_accuracy": round(best_acc, 1) if best_acc is not None else None,
            "member_since": member_since,
        })

    @app.route("/api/analyze", methods=["POST"])
    @optional_auth
    def analyze_upload():
        """Analyze an uploaded WAV file from the browser. Supports guest mode."""
        nonlocal results

        # User & Usage Limit Enforcement
        user = None
        guest = None
        if g.is_guest:
            guest = _get_or_create_guest()
            if not guest.can_analyze():
                resp = jsonify({"error": "GUEST_LIMIT_REACHED", "remaining_today": 0})
                resp.status_code = 403
                return _attach_guest_cookie(resp)
        else:
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
            # 1. Update streak/learning state (authenticated users only)
            learning_state = None
            if user is not None:
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
            if user is not None:
                last_session = Session.query.filter_by(user_id=user.user_id).order_by(Session.timestamp.desc()).first()
                last_metrics = last_session.performance_metric if last_session else None

                ai_context = {
                    "skill_level": user.skill_level or "beginner",
                    "goal": user.goal or "general improvement",
                    "language": user.language or "English",
                    "last_timing_error": last_metrics.timing_error if last_metrics else None,
                    "last_accuracy": last_metrics.pitch_accuracy if last_metrics else None
                }
            else:
                ai_context = {
                    "skill_level": "beginner",
                    "goal": "general improvement",
                    "language": "English",
                    "last_timing_error": None,
                    "last_accuracy": None,
                }
            # New user inputs from the focused UI
            user_problem = request.form.get("problem", "")
            focus = request.form.get("focus", "overall")
            style = request.form.get("style", "")
            scale_or_key = request.form.get("scale_or_key", "")
            rhythm_info = request.form.get("rhythm_info", "")
            
            ai_context.update({
                "problem": user_problem,
                "focus": focus,
                "style": style,
                "scale_or_key": scale_or_key,
                "rhythm_info": rhythm_info,
            })

            # Analyze
            report = analyze_wav_file(str(tmp), config, ai_context=ai_context, run_ai=False)
            
            # Silence Detection: threshold lowered to -60dB (more sensitive)
            # We skip AI only if it's practically absolute silence OR no notes were extracted
            is_silent = report.get("amplitude_db", -100) < -60 and not report.get("detected_notes")
            
            # Save Session to DB
            duration = report.get("duration", 0)
            backing_track_url = request.form.get("backing_track_url")
            # If silent, we mark it as 'completed' immediately with a skip flag
            ai_status = 'completed' if is_silent else 'processing'
            
            new_session = Session(
                user_id=user.user_id if user else None,
                guest_token=guest.anon_token if guest else None,
                bpm=config.analysis.bpm,
                duration=duration,
                backing_track_url=backing_track_url,
                ai_status=ai_status,
            )
            new_session.problem = user_problem
            new_session.focus = focus
            new_session.style = style
            db.session.add(new_session)
            db.session.flush() # get ID

            if is_silent:
                print(f"[Async AI] Silence detected ({report.get('amplitude_db')}dB). Skipping AI.")
                from feedback.ai_coach import AICoach
                coach = AICoach(config.ai)
                silent_advice = coach._silence_fallback(report)
                advice_payload, advice_meta = _normalize_ai_payload(silent_advice)
                fb = AIFeedback(
                    session_id=new_session.id,
                    summary=(advice_payload or {}).get("summary"),
                    detailed_feedback=json.dumps({
                        "advice": advice_payload,
                        "meta": advice_meta,
                    }),
                )
                db.session.add(fb)
            
            metrics = PerformanceMetric(
                session_id=new_session.id,
                pitch_accuracy=report.get("accuracy_pct", 0),
                timing_error=report.get("timing_error_ms", 0),
                timing_consistency=report.get("timing_consistency", 0),
                dynamics_db=report.get("amplitude_db", 0)
            )
            db.session.add(metrics)
            
            # Record usage
            if user is not None:
                user.record_usage()
            elif guest is not None:
                guest.record_usage()
            db.session.commit()
            
            # Start Async AI
            def run_async_ai(app_clone, sess_id, wave_path, cfg, rep, cxt, yt_url):
                with app_clone.app_context():
                    try:
                        from feedback.ai_coach import AICoach
                        coach = AICoach(cfg.ai)
                        if cfg.ai.enabled:
                            # Pass yt_url directly to Gemini native support
                            ai_advice = coach.evaluate_audio(wave_path, rep, cfg.analysis.bpm, cxt, yt_url)
                        else:
                            ai_advice = coach._fallback(rep)

                        advice_payload, advice_meta = _normalize_ai_payload(ai_advice)
                        
                        s = Session.query.get(sess_id)
                        if s:
                            s.ai_status = 'completed'
                            fb = AIFeedback(
                                session_id=sess_id,
                                summary=(advice_payload or {}).get("summary"),
                                detailed_feedback=json.dumps({
                                    "advice": advice_payload,
                                    "meta": advice_meta,
                                }),
                            )
                            db.session.add(fb)
                            # Save initial AI response as first chat message
                            first_chat = ChatMessage(
                                session_id=sess_id,
                                role="assistant",
                                content=json.dumps(advice_payload) if advice_payload else "Analysis complete."
                            )
                            db.session.add(first_chat)
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

            # Start Async AI only if not silent
            if not is_silent:
                app_clone = app
                # backing_track_url is now the raw YouTube URL from the frontend
                t = threading.Thread(target=run_async_ai, args=(app_clone, new_session.id, str(tmp), config, report, ai_context, backing_track_url))
                t.daemon = True
                t.start()

            response_payload = {
                "session_id": new_session.id,
                "status": "completed" if is_silent else "processing_ai",
                "accuracy_pct": report.get("accuracy_pct"),
                "bpm": config.analysis.bpm,
                "streak_days": learning_state.streak_days if learning_state else None,
                "current_focus": learning_state.current_focus if learning_state else None,
                "is_guest": g.is_guest,
                "remaining_today": (
                    guest.remaining_today if guest is not None
                    else (None if (user and user.plan == "pro") else max(0, 5 - user.usage_count) if user else None)
                ),
            }
            resp = jsonify(response_payload)
            return _attach_guest_cookie(resp)

        except Exception as exc:
            return jsonify({"error": str(exc)}), 500
        # tmp file removed in async thread

    def _can_access_session(session: Session) -> bool:
        """Check if current request (user or guest) owns the session."""
        if not g.is_guest:
            return session.user_id == g.user_id
        return bool(session.guest_token) and session.guest_token == g.guest_id

    @app.route("/api/session/<int:session_id>", methods=["GET"])
    @optional_auth
    def get_session(session_id):
        session = Session.query.get_or_404(session_id)
        if not _can_access_session(session):
            return jsonify({"error": "Unauthorized"}), 403
            
        metrics = session.performance_metric
        ai_fb = session.ai_feedback
        
        advice = None
        ai_meta = None
        if ai_fb and ai_fb.detailed_feedback:
            try:
                stored_feedback = json.loads(ai_fb.detailed_feedback)
                if isinstance(stored_feedback, dict) and "advice" in stored_feedback:
                    advice = stored_feedback.get("advice")
                    ai_meta = stored_feedback.get("meta")
                else:
                    advice = stored_feedback
            except Exception:
                pass

        return jsonify({
            "id": session.id,
            "ai_status": session.ai_status,
            "accuracy_pct": metrics.pitch_accuracy if metrics else 0,
            "bpm": session.bpm,
            "ai_advice": advice,
            "ai_meta": ai_meta,
        })

    @app.route("/api/session/<int:session_id>/chat", methods=["GET"])
    @optional_auth
    def get_chat_history(session_id):
        """Return the conversation history for a session."""
        session = Session.query.get_or_404(session_id)
        if not _can_access_session(session):
            return jsonify({"error": "Unauthorized"}), 403

        msgs = ChatMessage.query.filter_by(session_id=session_id).order_by(ChatMessage.id).all()
        return jsonify([
            {"role": m.role, "content": m.content, "timestamp": m.timestamp.isoformat()}
            for m in msgs
        ])

    @app.route("/api/session/<int:session_id>/chat", methods=["POST"])
    @optional_auth
    def send_chat_message(session_id):
        """Send a follow-up text message in the lesson conversation."""
        session = Session.query.get_or_404(session_id)
        if not _can_access_session(session):
            return jsonify({"error": "Unauthorized"}), 403

        data = request.get_json()
        user_message = (data.get("message") or "").strip()
        if not user_message:
            return jsonify({"error": "Message cannot be empty"}), 400

        # Build history from DB (last 10)
        existing = ChatMessage.query.filter_by(session_id=session_id).order_by(ChatMessage.id).all()
        history = [{"role": m.role, "content": m.content} for m in existing]

        # Save user message
        db.session.add(ChatMessage(session_id=session_id, role="user", content=user_message))
        db.session.commit()

        # Call AI follow-up
        from feedback.ai_coach import AICoach
        coach = AICoach(config.ai)
        user = User.query.get(g.user_id) if g.user_id else None
        session_context = {
            "problem": session.problem or "",
            "focus": session.focus or "overall",
            "style": session.style or "",
            "language": (user.language if user else None) or "English",
        }
        ai_response = coach.chat_followup(history, user_message, session_context)

        # Save AI response
        db.session.add(ChatMessage(session_id=session_id, role="assistant", content=ai_response))
        db.session.commit()

        return jsonify({"response": ai_response})

    @app.route("/api/chat", methods=["POST"])
    @optional_auth
    def stateless_chat():
        """Text-only chat with the AI teacher — no recording required.
        Body: { message, history: [{role, content}], context: {problem, focus, style, scale_or_key, rhythm_info} }
        """
        data = request.get_json()
        user_message = (data.get("message") or "").strip()
        if not user_message:
            return jsonify({"error": "Message cannot be empty"}), 400

        history = data.get("history") or []
        context = data.get("context") or {}

        # Ensure guest record exists so cookie can be set on response
        if g.is_guest:
            _get_or_create_guest()

        user = User.query.get(g.user_id) if g.user_id else None
        session_context = {
            "problem": context.get("problem", ""),
            "focus": context.get("focus", "overall"),
            "style": context.get("style", ""),
            "scale_or_key": context.get("scale_or_key", ""),
            "rhythm_info": context.get("rhythm_info", ""),
            "language": (user.language if user else None) or "English",
        }

        from feedback.ai_coach import AICoach
        coach = AICoach(config.ai)
        ai_response = coach.chat_followup(history, user_message, session_context)

        resp = jsonify({"response": ai_response})
        return _attach_guest_cookie(resp)

    @app.route("/api/feedback", methods=["POST"])
    @require_auth
    def submit_feedback():
        """Store developer feedback from users (visible only to developer)."""
        data = request.get_json()
        message = data.get("message", "").strip()
        session_id = data.get("session_id")

        if not message:
            return jsonify({"error": "Message cannot be empty"}), 400

        feedback = DeveloperFeedback(
            user_id=g.user_id,
            message=message,
            session_id=session_id if session_id else None
        )
        db.session.add(feedback)
        db.session.commit()

        return jsonify({
            "status": "ok",
            "feedback_id": feedback.id
        }), 201

    @app.route("/api/usage", methods=["GET"])
    @optional_auth
    def get_usage():
        """Return remaining analysis count for current user (guest or authenticated)."""
        if g.is_guest:
            guest = _get_or_create_guest()
            resp = jsonify({
                "is_guest": True,
                "plan": "guest",
                "remaining_today": guest.remaining_today,
                "daily_limit": 3,
            })
            return _attach_guest_cookie(resp)

        user = User.query.get(g.user_id)
        if not user:
            return jsonify({"is_guest": False, "plan": "free", "remaining_today": 5, "daily_limit": 5})

        if user.plan == "pro":
            return jsonify({"is_guest": False, "plan": "pro", "remaining_today": None, "daily_limit": None})

        today = datetime.date.today()
        used = user.usage_count if user.last_usage_date == today else 0
        return jsonify({
            "is_guest": False,
            "plan": user.plan,
            "remaining_today": max(0, 5 - used),
            "daily_limit": 5,
        })

    @app.route("/api/auth/migrate-guest", methods=["POST"])
    @require_auth
    def migrate_guest_to_user():
        """Migrate guest sessions to the now-authenticated user.
        Called by frontend right after sign-up/sign-in if an anon_token cookie exists.
        """
        anon_token = request.cookies.get("anon_token")
        if not anon_token:
            return jsonify({"migrated": 0})

        # Reassign sessions
        sessions_to_migrate = Session.query.filter_by(guest_token=anon_token).all()
        count = 0
        for s in sessions_to_migrate:
            s.user_id = g.user_id
            s.guest_token = None
            count += 1

        # Optionally remove guest record
        guest = GuestUser.query.get(anon_token)
        if guest:
            db.session.delete(guest)

        db.session.commit()

        # Clear cookie
        resp = jsonify({"migrated": count})
        resp.set_cookie(
            'anon_token', '',
            max_age=0, expires=0,
            httponly=True, samesite='Lax', secure=_COOKIE_SECURE,
        )
        return resp

    # ── Serve React build (production) ───────────────────────────────────────
    # Always register this catch-all so that React Router (HashRouter or BrowserRouter)
    # refreshes on any sub-route never cause a 404 from Flask.
    _static = static_dir  # capture for closure

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_react(path):
        # Never intercept API calls (safety net)
        if path and path.startswith("api/"):
            from flask import abort
            abort(404)
        if _static:
            full = os.path.join(_static, path)
            if path and os.path.exists(full):
                return send_from_directory(_static, path)
            return send_from_directory(_static, "index.html")
        # Dev mode without built frontend — return helpful message
        return jsonify({"message": "API running. Start the Vite dev server separately (npm run dev in frontend/)."}), 200

    return app
