"""Audio capture engine using sounddevice."""

import sounddevice as sd
import numpy as np
from typing import Optional, Callable

from audio.ring_buffer import RingBuffer
from config import AudioConfig


class AudioEngine:
    """Captures audio from an input device into a ring buffer.

    Uses sounddevice (PortAudio backend). On Windows without ASIO,
    it will use WASAPI which is fine for the Boss Katana USB interface.
    """

    def __init__(self, config: AudioConfig, buffer_seconds: float = 5.0):
        self.config = config
        self._buffer_size = int(config.sample_rate * buffer_seconds)
        self.buffer = RingBuffer(self._buffer_size, dtype=config.dtype)
        self._stream: Optional[sd.InputStream] = None
        self._on_data_callback: Optional[Callable] = None

    def _audio_callback(self, indata: np.ndarray, frames: int,
                        time_info, status):
        """Called by sounddevice on each audio block."""
        if status:
            print(f"[AudioEngine] status: {status}")
        # indata shape: (frames, channels) — flatten to mono
        mono = indata[:, 0] if indata.ndim > 1 else indata.flatten()
        self.buffer.write(mono)

        if self._on_data_callback:
            self._on_data_callback(mono)

    def start(self, on_data: Optional[Callable] = None):
        """Start capturing audio."""
        self._on_data_callback = on_data
        self.buffer.clear()

        self._stream = sd.InputStream(
            samplerate=self.config.sample_rate,
            blocksize=self.config.block_size,
            channels=self.config.channels,
            dtype=self.config.dtype,
            device=self.config.device_index,
            callback=self._audio_callback,
        )
        self._stream.start()
        print(f"[AudioEngine] Started — SR={self.config.sample_rate}, "
              f"block={self.config.block_size}, "
              f"device={self.config.device_index or 'default'}")

    def stop(self):
        """Stop capturing audio."""
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None
            print("[AudioEngine] Stopped")

    def get_buffer(self, n_samples: int) -> np.ndarray:
        """Read n_samples from the ring buffer (consuming them)."""
        return self.buffer.read(n_samples)

    def peek_buffer(self, n_samples: int) -> np.ndarray:
        """Peek n_samples without consuming."""
        return self.buffer.peek(n_samples)

    @property
    def is_running(self) -> bool:
        return self._stream is not None and self._stream.active

    @staticmethod
    def list_devices() -> str:
        """List available audio devices."""
        return str(sd.query_devices())

    @staticmethod
    def get_default_device_info() -> dict:
        """Get info about the default input device."""
        idx = sd.default.device[0]
        info = sd.query_devices(idx)
        return dict(info)
