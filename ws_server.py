"""
ws_server.py  —  ToneCoach WebSocket server

Receives real-time pitch data from the JUCE app and prints a live tuner display.

Install dependency (once):
    pip install websockets

Run:
    python ws_server.py

The JUCE app connects automatically to ws://127.0.0.1:8765.
Start this server BEFORE (or after) launching ToneCoach — it reconnects automatically.
"""

import asyncio
import json
import os
import sys
from datetime import datetime

try:
    import websockets
except ImportError:
    print("Missing dependency. Run:  pip install websockets")
    sys.exit(1)

HOST = "127.0.0.1"
PORT = 8765

# ── ANSI colours (enabled on Windows via os.system trick) ───
os.system("")
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
GREY   = "\033[90m"
BOLD   = "\033[1m"
RESET  = "\033[0m"


def status_colour(status: str) -> str:
    if status == "In Tune!":  return GREEN
    if status == "NoSignal":  return GREY
    return RED


def cents_bar(cents: float, width: int = 42) -> str:
    """ASCII needle: centre = 0c, left = flat, right = sharp."""
    centre = width // 2
    pos    = int(centre + (cents / 50.0) * centre)
    pos    = max(0, min(width - 1, pos))

    bar         = [GREY + "─" + RESET] * width
    bar[centre] = GREY + "│" + RESET           # zero reference mark
    colour      = GREEN if abs(cents) <= 5 else RED
    bar[pos]    = colour + "█" + RESET
    return "".join(bar)


# ── Track some statistics ────────────────────────────────────
stats = {
    "messages": 0,
    "connections": 0,
}


async def handler(websocket):
    """Handle one JUCE client connection."""
    stats["connections"] += 1
    peer = websocket.remote_address
    print(f"\n{CYAN}[{datetime.now():%H:%M:%S}] Client connected: {peer}{RESET}")
    print(f"{'─' * 70}")
    print(f"{'Note':>4}  {'Freq':>8}  {'Needle':^44}  {'Cents':>7}  Status")
    print(f"{'─' * 70}")

    try:
        async for message in websocket:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                continue

            note   = data.get("note",      "--")
            freq   = data.get("frequency",  0.0)
            cents  = data.get("cents",      0.0)
            status = data.get("status",    "NoSignal")

            stats["messages"] += 1
            col = status_colour(status)
            bar = cents_bar(cents)

            print(
                f"\r{BOLD}{col}{note:>4}{RESET}  "
                f"{freq:7.1f} Hz  "
                f"[{bar}]  "
                f"{col}{cents:+6.1f}c{RESET}  "
                f"{col}{status:<10}{RESET}",
                end="", flush=True
            )

    except websockets.exceptions.ConnectionClosedOK:
        pass
    except websockets.exceptions.ConnectionClosedError as e:
        print(f"\n{YELLOW}Connection lost: {e}{RESET}")

    print(f"\n{GREY}[{datetime.now():%H:%M:%S}] Client disconnected. "
          f"Total messages: {stats['messages']}{RESET}")


async def main():
    print(f"{BOLD}ToneCoach WebSocket Server{RESET}")
    print(f"Listening on  ws://{HOST}:{PORT}")
    print(f"Waiting for JUCE app to connect...\n")

    # ping_interval=None  →  disable automatic server→client pings.
    # The JUCE client already handles pings on its side; automatic pings from
    # the Python library caused disconnects because the C++ side didn't reply
    # fast enough (it was only checking every 20 s by default).
    async with websockets.serve(handler, HOST, PORT,
                                ping_interval=None):
        await asyncio.Future()   # run forever



if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n{GREY}Server stopped.{RESET}")
