"""Audio diagnostic script — debug audio input issues.

Run this to check:
1. What audio devices are available
2. Which one is your Boss Katana
3. Whether audio signal is actually coming through
4. What signal levels look like
"""

import sounddevice as sd
import numpy as np
import time
import sys


def list_all_devices():
    """Show all audio devices with detailed info."""
    print("\n" + "=" * 70)
    print("ALL AUDIO DEVICES")
    print("=" * 70)
    
    devices = sd.query_devices()
    hostapis = sd.query_hostapis()
    
    print(f"\nHost APIs available: {len(hostapis)}")
    for i, api in enumerate(hostapis):
        print(f"  [{i}] {api['name']}")
    
    print(f"\nTotal devices: {len(devices)}")
    print("-" * 70)
    
    input_devices = []
    for i, d in enumerate(devices):
        if d['max_input_channels'] > 0:
            api_name = hostapis[d['hostapi']]['name']
            print(f"  INPUT [{i}] {d['name']}")
            print(f"         Host API: {api_name}")
            print(f"         Channels: {d['max_input_channels']}")
            print(f"         Sample Rate: {d['default_samplerate']}")
            print(f"         Low Latency: {d['default_low_input_latency']*1000:.1f}ms")
            print(f"         High Latency: {d['default_high_input_latency']*1000:.1f}ms")
            print()
            input_devices.append((i, d, api_name))
    
    if not input_devices:
        print("  *** NO INPUT DEVICES FOUND! ***")
        return []
    
    # Show default
    default_in = sd.default.device[0]
    print(f"Default input device index: {default_in}")
    if default_in is not None and default_in >= 0:
        print(f"Default input device name:  {devices[default_in]['name']}")
    
    return input_devices


def test_device(device_index: int, duration_s: float = 3.0):
    """Test recording from a specific device and show signal levels."""
    info = sd.query_devices(device_index)
    sr = int(info['default_samplerate'])
    channels = min(info['max_input_channels'], 2)  # max 2 channels
    
    print(f"\n{'=' * 70}")
    print(f"TESTING DEVICE [{device_index}]: {info['name']}")
    print(f"  Sample rate: {sr}, Channels: {channels}")
    print(f"  Recording for {duration_s} seconds...")
    print(f"  >>> PLAY YOUR GUITAR NOW! <<<")
    print(f"{'=' * 70}\n")
    
    try:
        # Record audio
        recording = sd.rec(
            int(sr * duration_s),
            samplerate=sr,
            channels=channels,
            device=device_index,
            dtype='float32'
        )
        
        # Show live levels while recording
        start = time.time()
        while time.time() - start < duration_s:
            elapsed = time.time() - start
            samples_so_far = int(elapsed * sr)
            if samples_so_far > 100:
                chunk = recording[:samples_so_far, 0] if channels > 0 else recording[:samples_so_far].flatten()
                # Only look at recent samples
                recent = chunk[max(0, len(chunk)-sr//4):]
                if len(recent) > 0:
                    rms = np.sqrt(np.mean(recent ** 2))
                    peak = np.max(np.abs(recent))
                    db = 20 * np.log10(rms) if rms > 0 else -100
                    
                    # Visual bar
                    bar_len = int(max(0, (db + 60)) * 0.8)
                    bar = "█" * bar_len + "░" * (48 - bar_len)
                    
                    sys.stdout.write(f"\r  [{elapsed:4.1f}s] RMS: {rms:.6f} | Peak: {peak:.6f} | {db:6.1f} dB |{bar}|")
                    sys.stdout.flush()
            time.sleep(0.1)
        
        sd.wait()  # Wait for recording to finish
        print("\n")
        
        # Analyze the full recording
        mono = recording[:, 0] if recording.ndim > 1 else recording.flatten()
        
        rms_total = np.sqrt(np.mean(mono ** 2))
        peak_total = np.max(np.abs(mono))
        db_total = 20 * np.log10(rms_total) if rms_total > 0 else -100
        db_peak = 20 * np.log10(peak_total) if peak_total > 0 else -100
        
        print(f"  RESULTS:")
        print(f"    Total samples: {len(mono)}")
        print(f"    RMS amplitude: {rms_total:.8f}")
        print(f"    Peak amplitude: {peak_total:.8f}")
        print(f"    RMS dB: {db_total:.1f} dB")
        print(f"    Peak dB: {db_peak:.1f} dB")
        print(f"    Min value: {np.min(mono):.8f}")
        print(f"    Max value: {np.max(mono):.8f}")
        print(f"    Non-zero samples: {np.count_nonzero(mono)} / {len(mono)}")
        
        # Diagnose
        print(f"\n  DIAGNOSIS:")
        if peak_total < 1e-7:
            print(f"    ❌ NO SIGNAL DETECTED - device is completely silent")
            print(f"       → Check if Boss Katana USB audio is enabled")
            print(f"       → Check Windows Sound Settings → Recording devices")
            print(f"       → Make sure guitar volume is up")
        elif peak_total < 0.001:
            print(f"    ⚠️  VERY WEAK SIGNAL - barely any audio")
            print(f"       → Turn up the gain/volume on your Boss Katana")
            print(f"       → Check USB recording level in Boss Tone Studio")
        elif peak_total < 0.01:
            print(f"    ⚠️  WEAK SIGNAL - audio detected but very quiet")
            print(f"       → Increase input gain")
        else:
            print(f"    ✅ SIGNAL DETECTED - audio is coming through!")
            print(f"       Signal level looks {'good' if peak_total > 0.1 else 'usable'}")
        
        return mono, sr
        
    except Exception as e:
        print(f"\n  ❌ ERROR: {e}")
        print(f"     This device might not support the requested settings.")
        return None, sr


def test_callback_mode(device_index: int, duration_s: float = 3.0):
    """Test using callback mode (same as our app uses)."""
    info = sd.query_devices(device_index)
    sr = int(info['default_samplerate'])
    
    print(f"\n{'=' * 70}")
    print(f"TESTING CALLBACK MODE (like our app)")
    print(f"  Device [{device_index}]: {info['name']}")
    print(f"  >>> PLAY YOUR GUITAR NOW! <<<")
    print(f"{'=' * 70}\n")
    
    frames_received = []
    peak_levels = []
    
    def callback(indata, frames, time_info, status):
        if status:
            print(f"  [callback status: {status}]")
        mono = indata[:, 0] if indata.ndim > 1 else indata.flatten()
        frames_received.append(len(mono))
        peak = np.max(np.abs(mono))
        peak_levels.append(peak)
    
    try:
        stream = sd.InputStream(
            samplerate=sr,
            blocksize=1024,
            channels=1,
            dtype='float32',
            device=device_index,
            callback=callback,
        )
        
        stream.start()
        print(f"  Stream started (SR={sr}, block=1024, mono)")
        
        start = time.time()
        while time.time() - start < duration_s:
            time.sleep(0.2)
            if peak_levels:
                recent_peak = max(peak_levels[-5:]) if len(peak_levels) >= 5 else max(peak_levels)
                db = 20 * np.log10(recent_peak) if recent_peak > 0 else -100
                bar_len = int(max(0, (db + 60)) * 0.8)
                bar = "█" * bar_len + "░" * (48 - bar_len)
                sys.stdout.write(f"\r  Callbacks: {len(frames_received):4d} | Peak: {recent_peak:.6f} | {db:6.1f} dB |{bar}|")
                sys.stdout.flush()
        
        stream.stop()
        stream.close()
        
        print(f"\n\n  RESULTS:")
        print(f"    Total callbacks: {len(frames_received)}")
        print(f"    Total frames: {sum(frames_received)}")
        if peak_levels:
            print(f"    Max peak level: {max(peak_levels):.8f}")
            print(f"    Avg peak level: {np.mean(peak_levels):.8f}")
            non_silent = sum(1 for p in peak_levels if p > 1e-6)
            print(f"    Non-silent callbacks: {non_silent} / {len(peak_levels)}")
            
            if max(peak_levels) < 1e-7:
                print(f"\n    ❌ CALLBACK MODE: No signal in any callback")
            elif max(peak_levels) > 0.01:
                print(f"\n    ✅ CALLBACK MODE: Signal is coming through!")
            else:
                print(f"\n    ⚠️  CALLBACK MODE: Very weak signal")
        
    except Exception as e:
        print(f"\n  ❌ CALLBACK ERROR: {e}")


def main():
    print("\n🎸 AI Guitar Coach — Audio Diagnostic Tool")
    print("=" * 70)
    
    # Step 1: List devices
    input_devices = list_all_devices()
    
    if not input_devices:
        print("\nNo input devices found. Check your audio drivers.")
        return
    
    # Step 2: Let user pick a device
    print(f"\n{'=' * 70}")
    print("Which device do you want to test?")
    print(f"{'=' * 70}")
    for idx, (dev_idx, d, api) in enumerate(input_devices):
        print(f"  {idx + 1}) [{dev_idx}] {d['name']} ({api})")
    
    print(f"\nEnter number (1-{len(input_devices)}), or 'a' to test ALL, or 'q' to quit:")
    
    try:
        choice = input("> ").strip()
    except (EOFError, KeyboardInterrupt):
        return
    
    if choice.lower() == 'q':
        return
    
    if choice.lower() == 'a':
        # Test all devices
        for dev_idx, d, api in input_devices:
            test_device(dev_idx, duration_s=3.0)
            test_callback_mode(dev_idx, duration_s=3.0)
        return
    
    try:
        pick = int(choice) - 1
        if 0 <= pick < len(input_devices):
            dev_idx = input_devices[pick][0]
            
            # Test with simple recording
            test_device(dev_idx, duration_s=5.0)
            
            # Test with callback mode (like our app)
            test_callback_mode(dev_idx, duration_s=5.0)
        else:
            print("Invalid selection.")
    except ValueError:
        print("Invalid input.")


if __name__ == "__main__":
    main()
