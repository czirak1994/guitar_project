"""Audio recorder — captures guitar input to a temporary WAV file.

Records until stop_event is set OR the max duration is reached.
In CLI mode, Enter key sets the stop_event.
In GUI/API mode, the caller sets it directly.
"""

import tempfile
import threading
import time
import sys
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

# Force UTF-8 output on Windows
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')



# Host APIs that are safe on Windows (no crash-prone WDM-KS/DirectSound).
_SAFE_APIS = {"Windows WASAPI", "MME"}


def _device_score(name: str, api_name: str) -> int:
    """Score a device for auto-selection (higher = better).

    For guitar interfaces (Katana etc.) we prefer MME over WASAPI because
    the WASAPI Katana driver triggers a WdmSyncIoctl error (PaErrorCode -9999)
    during production streaming even though a quick probe succeeds.
    For generic/unknown devices WASAPI is still preferred (lower latency).
    """
    score = 0
    name_up = name.upper()

    # Detect guitar interface keywords
    is_guitar = any(kw in name_up for kw in ("KATANA", "GUITAR", "AMP", "LINE IN", "INSTRUMENT"))

    if is_guitar:
        # For guitar interfaces prefer MME — more compatible on Windows
        if "MME" in api_name:
            score += 100
        elif "WASAPI" in api_name:
            score += 50
    else:
        # Generic devices: WASAPI > MME
        if "WASAPI" in api_name:
            score += 100
        elif "MME" in api_name:
            score += 10

    # Prefer PRIMARY channel on multi-channel interfaces (e.g. Boss Katana)
    if "PRIMARY" in name_up:
        score += 20
    elif "SECONDARY" in name_up:
        score -= 10

    # Boost guitar interface keywords
    if is_guitar:
        score += 30

    # Penalise generic Windows fallback names
    for kw in ("MICROSOFT", "REALTEK MIC", "STEREO MIX", "HANGLEKÉPZŐ", "HANGRÖGZÍTŐ"):
        if kw in name_up:
            score -= 50
            break

    return score


def _probe_device(index: int, sample_rate: int = 44100, channels: int = 1,
                   block_size: int = 1024) -> bool:
    """Try to open device with production settings to verify it actually works.

    Uses the same blocksize as the real recording so the WASAPI latency query
    (which triggers WdmSyncIoctl) behaves identically to the recording stream.
    Some WASAPI devices (e.g. Boss Katana) probe OK with tiny buffers but fail
    with larger ones; this catches it at startup instead of at recording time.
    """
    try:
        stream = sd.InputStream(
            samplerate=sample_rate,
            blocksize=block_size,
            channels=channels,
            dtype="float32",
            device=index,
        )
        stream.start()
        stream.stop()
        stream.close()
        return True
    except Exception as exc:
        print(f"  [probe] device [{index}] failed: {exc}")
        return False


def _pick_safe_input_device() -> int | None:
    """Return the index of the best safe input device that actually opens.

    Scores all WASAPI + MME input devices, then probes them in score order
    (highest first), returning the first one that can be opened without error.
    This automatically avoids devices like WASAPI Katana that trigger the
    WDM-KS PaErrorCode -9999 bug on Windows.
    """
    try:
        devices   = sd.query_devices()
        host_apis = sd.query_hostapis()
    except Exception:
        return None

    # Collect and score all safe input candidates
    candidates: list[tuple[int, int]] = []   # (score, index)

    for i, d in enumerate(devices):
        if d["max_input_channels"] <= 0:
            continue
        try:
            api_name = host_apis[d["hostapi"]]["name"]
        except (IndexError, KeyError):
            continue
        if api_name not in _SAFE_APIS:
            continue
        score = _device_score(d["name"], api_name)
        candidates.append((score, i))

    # Sort descending by score, then probe each until one works
    candidates.sort(reverse=True)
    for score, idx in candidates:
        try:
            dev_name = devices[idx]["name"]
            sr       = int(devices[idx]["default_samplerate"])
        except Exception:
            continue
        print(f"  [probe] trying [{idx}] '{dev_name}' (score={score}, {sr}Hz)…")
        if _probe_device(idx, sr):
            print(f"  [probe] selected [{idx}] '{dev_name}'")
            return idx

    return None


def record_to_wav(
    max_duration_s: float = 30.0,
    sample_rate: int = 44100,
    channels: int = 1,
    device_index: int | None = None,
    block_size: int = 1024,
    stop_event: threading.Event | None = None,
    cli_mode: bool = True,
) -> Path:
    """Record audio until stop_event is set or max_duration_s elapses.

    Args:
        max_duration_s: hard upper limit for the recording.
        sample_rate: audio sample rate (Hz).
        channels: number of input channels (1 = mono).
        device_index: PortAudio device index; None = auto-detect safe device.
        block_size: samples per callback block.
        stop_event: optional external event to signal stop.
            If None and cli_mode=True, a new event is created and
            the Enter key is used to set it.
        cli_mode: if True, prints progress to stdout.

    Returns:
        Path to a temporary WAV file (caller must delete it).
    """
    # If no device specified, pick the first safe (WASAPI/MME) input device
    # to avoid WDM-KS crashes (PortAudio PaErrorCode -9999).
    if device_index is None:
        device_index = _pick_safe_input_device()
        if device_index is not None and cli_mode:
            try:
                dev_name = sd.query_devices(device_index)["name"]
                print(f"  [recorder] Auto-selected device [{device_index}]: {dev_name}")
            except Exception:
                pass

    chunks: list[np.ndarray] = []

    # Use provided event or create one for CLI Enter-key control
    if stop_event is None:
        stop_event = threading.Event()
        _start_enter_listener(stop_event, cli_mode)

    # ── PortAudio callback ────────────────────────────────────────────────────
    def _callback(indata: np.ndarray, frames: int, time_info, status):
        if status and cli_mode:
            print(f"  [recorder] {status}")
        chunks.append(indata[:, 0].copy() if indata.ndim > 1 else indata.flatten().copy())

    if cli_mode:
        print(f"🎙  Recording... press ENTER to stop (max {int(max_duration_s)}s)")
        print("    ► Play your guitar now!")

    try:
        stream = sd.InputStream(
            samplerate=sample_rate,
            blocksize=block_size,
            channels=channels,
            dtype="float32",
            device=device_index,
            callback=_callback,
        )
    except Exception as e:
        raise RuntimeError(f"Could not open audio device: {e}") from e

    with stream:
        deadline = time.time() + max_duration_s
        while not stop_event.is_set():
            remaining = deadline - time.time()
            if remaining <= 0:
                if cli_mode:
                    print(f"\n⏱  Max duration ({int(max_duration_s)}s) reached — stopping.")
                break
            if cli_mode:
                elapsed = max_duration_s - remaining
                print(f"\r    {elapsed:5.1f}s / {int(max_duration_s)}s", end="", flush=True)
            time.sleep(0.1)

    if cli_mode:
        print()  # newline after counter

    if not chunks:
        raise RuntimeError("No audio was recorded. Check your input device.")

    audio = np.concatenate(chunks)
    duration = len(audio) / sample_rate

    if cli_mode:
        print(f"✅  Captured {duration:.1f}s of audio ({len(audio):,} samples)")

    # ── Save to temp file ────────────────────────────────────────────────────
    tmp = tempfile.NamedTemporaryFile(
        suffix=".wav",
        prefix="guitar_",
        delete=False,
    )
    tmp.close()

    sf.write(tmp.name, audio, sample_rate, subtype="PCM_16")
    out_path = Path(tmp.name)

    if cli_mode:
        print(f"💾  Saved to: {out_path}")

    return out_path


def _start_enter_listener(stop_event: threading.Event, cli_mode: bool):
    """Start a daemon thread that sets stop_event when Enter is pressed."""
    def _wait():
        try:
            input()
        except EOFError:
            pass
        stop_event.set()

    t = threading.Thread(target=_wait, daemon=True)
    t.start()
