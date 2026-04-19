"""
pitch_reader.py  —  reads ToneCoach's pitch_data.json and prints live tuner state.

Run this while ToneCoach is open:
    python pitch_reader.py

The JSON file is written by ToneCoach every ~500 ms to:
    C:\\Users\\<you>\\Documents\\ToneCoach\\pitch_data.json
"""

import json
import os
import time
from pathlib import Path

# ── Path to the JSON file ToneCoach writes ──────────────────
JSON_PATH = Path.home() / "Documents" / "ToneCoach" / "pitch_data.json"

POLL_INTERVAL = 0.5   # seconds between reads

# ANSI colours (Windows: enable with `os.system('color')` first)
os.system("")  # enable ANSI on Windows terminal
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

def status_colour(status: str) -> str:
    if status == "In Tune!":
        return GREEN
    if status == "NoSignal":
        return YELLOW
    return RED

def cents_bar(cents: float, width: int = 40) -> str:
    """Draw a simple ASCII needle bar centred at 0."""
    centre = width // 2
    pos = int(centre + (cents / 50.0) * centre)
    pos = max(0, min(width - 1, pos))

    bar = ["-"] * width
    bar[centre] = "|"   # zero reference
    bar[pos] = "■"

    colour = GREEN if abs(cents) <= 5 else RED
    return colour + "".join(bar) + RESET

def main():
    print(f"Watching: {JSON_PATH}")
    print("Press Ctrl+C to stop.\n")

    last_timestamp = None

    while True:
        try:
            if not JSON_PATH.exists():
                print(f"\r[waiting for ToneCoach...]", end="", flush=True)
                time.sleep(POLL_INTERVAL)
                continue

            with open(JSON_PATH, "r") as f:
                data = json.load(f)

            ts = data.get("timestamp", 0)
            if ts == last_timestamp:
                # No new data yet — just wait
                time.sleep(POLL_INTERVAL)
                continue
            last_timestamp = ts

            note   = data.get("note",      "--")
            freq   = data.get("frequency",  0.0)
            cents  = data.get("cents",      0.0)
            status = data.get("status",    "NoSignal")

            col = status_colour(status)
            bar = cents_bar(cents)

            print(
                f"\r{BOLD}{col}{note:>3}{RESET}  "
                f"{freq:6.1f} Hz  "
                f"{bar}  "
                f"{cents:+6.1f}c  "
                f"{col}{status:<10}{RESET}",
                end="", flush=True
            )

        except (json.JSONDecodeError, KeyError):
            # File was being written — skip this tick
            pass
        except KeyboardInterrupt:
            print("\nStopped.")
            break

        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()
