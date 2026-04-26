import datetime
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = 'users'
    
    user_id = db.Column(db.String, primary_key=True)  # Clerk User ID
    email = db.Column(db.String, unique=True, nullable=True)
    plan = db.Column(db.String, default="free")  # "free" or "pro"
    usage_count = db.Column(db.Integer, default=0)
    last_usage_date = db.Column(db.Date, default=datetime.date.today)
    
    skill_level = db.Column(db.String, nullable=True) # beginner, intermediate, advanced
    goal = db.Column(db.String, nullable=True) # rhythm, soloing, timing, technique
    language = db.Column(db.String, default="English")
    stripe_customer_id = db.Column(db.String, nullable=True)  # Stripe Customer ID for billing portal

    sessions = db.relationship('Session', backref='user', lazy=True)
    learning_state = db.relationship('LearningState', backref='user', uselist=False, lazy=True)

    def can_analyze(self) -> bool:
        today = datetime.datetime.utcnow().date()
        # Reset limit if it's a new day
        if self.last_usage_date != today:
            self.usage_count = 0
            self.last_usage_date = today

        if self.plan == "pro":
            return True
        return self.usage_count < 5

    def record_usage(self):
        self.usage_count += 1


class GuestUser(db.Model):
    """Anonymous user tracked by cookie token + IP."""
    __tablename__ = 'guest_users'

    anon_token = db.Column(db.String, primary_key=True)   # UUID
    ip_address = db.Column(db.String, nullable=True)
    usage_count = db.Column(db.Integer, default=0)
    last_usage_date = db.Column(db.Date, default=datetime.date.today)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

    def can_analyze(self) -> bool:
        today = datetime.datetime.utcnow().date()
        if self.last_usage_date != today:
            self.usage_count = 0
            self.last_usage_date = today
        return self.usage_count < 3  # Guests: 3/day

    def record_usage(self):
        self.usage_count += 1

    @property
    def remaining_today(self) -> int:
        today = datetime.datetime.utcnow().date()
        if self.last_usage_date != today:
            return 3
        return max(0, 3 - self.usage_count)


class Session(db.Model):
    __tablename__ = 'sessions'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.String, db.ForeignKey('users.user_id'), nullable=True)
    guest_token = db.Column(db.String, nullable=True)  # Links to GuestUser.anon_token
    timestamp = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    bpm = db.Column(db.Float, nullable=True)
    duration = db.Column(db.Float, nullable=True)
    ai_status = db.Column(db.String, default='pending') # pending, completed, failed
    backing_track_url = db.Column(db.String, nullable=True)
    problem = db.Column(db.String, nullable=True)  # User's stated problem
    focus = db.Column(db.String, nullable=True)    # Selected focus area: Timing, Rhythm, Technique, Tone
    style = db.Column(db.String, nullable=True)    # Guitar style: Metal, Blues, Jazz, etc.
    
    performance_metric = db.relationship('PerformanceMetric', backref='session', uselist=False, lazy=True)
    ai_feedback = db.relationship('AIFeedback', backref='session', uselist=False, lazy=True)
    chat_messages = db.relationship('ChatMessage', backref='session', lazy=True, order_by='ChatMessage.id')


class PerformanceMetric(db.Model):
    __tablename__ = 'performance_metrics'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    session_id = db.Column(db.Integer, db.ForeignKey('sessions.id'), nullable=False)
    pitch_accuracy = db.Column(db.Float, nullable=True)
    timing_error = db.Column(db.Float, nullable=True)
    timing_consistency = db.Column(db.Float, nullable=True)
    dynamics_db = db.Column(db.Float, nullable=True)


class AIFeedback(db.Model):
    __tablename__ = 'ai_feedback'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    session_id = db.Column(db.Integer, db.ForeignKey('sessions.id'), nullable=False)
    summary = db.Column(db.Text, nullable=True)
    detailed_feedback = db.Column(db.Text, nullable=True)


class LearningState(db.Model):
    __tablename__ = 'learning_state'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.String, db.ForeignKey('users.user_id'), nullable=False)
    current_focus = db.Column(db.String, default="Complete a benchmark session to get your first focus.")
    last_improvement_score = db.Column(db.Float, nullable=True)
    streak_days = db.Column(db.Integer, default=0)
    last_practice_date = db.Column(db.Date, nullable=True)

class DeveloperFeedback(db.Model):
    __tablename__ = 'developer_feedback'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.String, db.ForeignKey('users.user_id'), nullable=True)
    timestamp = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    message = db.Column(db.Text, nullable=False)
    session_id = db.Column(db.Integer, db.ForeignKey('sessions.id'), nullable=True)  # Optional link to session


class ChatMessage(db.Model):
    __tablename__ = 'chat_messages'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    session_id = db.Column(db.Integer, db.ForeignKey('sessions.id'), nullable=False)
    role = db.Column(db.String, nullable=False)   # 'user' or 'assistant'
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.datetime.utcnow)
