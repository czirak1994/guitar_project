import os
from config import AppConfig
from api.server import create_api

# This file is used by Gunicorn to serve the app on Railway.
config = AppConfig()

# In production on Railway, the static directory will be frontend/dist
static_dir = os.environ.get("STATIC_DIR", os.path.join(os.path.dirname(__file__), "frontend", "dist"))

app = create_api(config, static_dir=static_dir)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
