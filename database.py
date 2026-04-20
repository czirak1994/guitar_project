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


class Session(db.Model):
    __tablename__ = 'sessions'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.String, db.ForeignKey('users.user_id'), nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    bpm = db.Column(db.Float, nullable=True)
    duration = db.Column(db.Float, nullable=True)
    
    performance_metric = db.relationship('PerformanceMetric', backref='session', uselist=False, lazy=True)
    ai_feedback = db.relationship('AIFeedback', backref='session', uselist=False, lazy=True)


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
