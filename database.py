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

    def can_analyze(self) -> bool:
        today = datetime.date.today()
        # Reset limit if it's a new day
        if self.last_usage_date != today:
            self.usage_count = 0
            self.last_usage_date = today

        if self.plan == "pro":
            return True
        return self.usage_count < 5

    def record_usage(self):
        self.usage_count += 1
