"""Thread-safe ring buffer for audio data."""

import numpy as np
import threading


class RingBuffer:
    """Fixed-size circular buffer backed by a numpy array.

    Thread-safe for single-producer / single-consumer use
    (audio callback writes, main thread reads).
    """

    def __init__(self, capacity: int, dtype: str = "float32"):
        self._buf = np.zeros(capacity, dtype=dtype)
        self._capacity = capacity
        self._write_pos = 0
        self._read_pos = 0
        self._lock = threading.Lock()

    @property
    def capacity(self) -> int:
        return self._capacity

    def available(self) -> int:
        """Number of samples available to read."""
        with self._lock:
            return (self._write_pos - self._read_pos) % self._capacity

    def write(self, data: np.ndarray) -> int:
        """Write samples into the buffer. Returns number of samples written."""
        n = len(data)
        if n == 0:
            return 0

        with self._lock:
            free = self._capacity - ((self._write_pos - self._read_pos) % self._capacity) - 1
            n_write = min(n, free)
            if n_write == 0:
                return 0

            wp = self._write_pos % self._capacity
            end = wp + n_write

            if end <= self._capacity:
                self._buf[wp:end] = data[:n_write]
            else:
                first = self._capacity - wp
                self._buf[wp:] = data[:first]
                self._buf[:n_write - first] = data[first:n_write]

            self._write_pos += n_write
            return n_write

    def read(self, n: int) -> np.ndarray:
        """Read up to n samples from the buffer."""
        with self._lock:
            avail = (self._write_pos - self._read_pos) % self._capacity
            n_read = min(n, avail)
            if n_read == 0:
                return np.array([], dtype=self._buf.dtype)

            rp = self._read_pos % self._capacity
            end = rp + n_read

            if end <= self._capacity:
                out = self._buf[rp:end].copy()
            else:
                first = self._capacity - rp
                out = np.concatenate([
                    self._buf[rp:],
                    self._buf[:n_read - first]
                ])

            self._read_pos += n_read
            return out

    def peek(self, n: int) -> np.ndarray:
        """Read n samples without consuming them."""
        with self._lock:
            avail = (self._write_pos - self._read_pos) % self._capacity
            n_read = min(n, avail)
            if n_read == 0:
                return np.array([], dtype=self._buf.dtype)

            rp = self._read_pos % self._capacity
            end = rp + n_read

            if end <= self._capacity:
                return self._buf[rp:end].copy()
            else:
                first = self._capacity - rp
                return np.concatenate([
                    self._buf[rp:],
                    self._buf[:n_read - first]
                ])

    def clear(self):
        """Reset the buffer."""
        with self._lock:
            self._write_pos = 0
            self._read_pos = 0
