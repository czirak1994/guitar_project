import os
import sys

print("[BOOT] Starting wsgi.py...")

try:
    from config import AppConfig
    from api.server import create_api

    print("[BOOT] Imports successful")

    config = AppConfig()
    static_dir = os.environ.get("STATIC_DIR", os.path.join(os.path.dirname(__file__), "frontend", "dist"))
    
    print(f"[BOOT] Static dir path: {static_dir}")
    if os.path.exists(static_dir):
        print(f"[BOOT] Static dir EXISTS. Contents: {os.listdir(static_dir)[:5]}")
    else:
        print("[BOOT] WARNING: Static dir DOES NOT EXIST!")

    print("[BOOT] Creating API...")
    app = create_api(config, static_dir=static_dir)
    print("[BOOT] API created successfully!")

    if __name__ == "__main__":
        port = int(os.environ.get("PORT", 5000))
        app.run(host="0.0.0.0", port=port)

except Exception as e:
    print(f"[BOOT ERROR] {str(e)}", file=sys.stderr)
    import traceback
    traceback.print_exc()
    raise

