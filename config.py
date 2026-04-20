"""Application configuration for AI Guitar Coach."""

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class AudioConfig:
    """Audio engine configuration."""
    sample_rate: int = 44100
    block_size: int = 1024          # samples per callback (~23ms at 44100)
    channels: int = 1               # mono
    device_index: Optional[int] = None  # None = system default
    dtype: str = "float32"
    latency_offset_ms: float = 0.0  # subtract from onset times to compensate USB/driver latency


@dataclass
class DSPConfig:
    """Signal processing configuration."""
    # Pitch detection (YIN)
    yin_threshold: float = 0.20     # confidence threshold (lower = stricter)
    yin_frame_size: int = 2048      # samples per analysis window
    yin_hop_size: int = 512         # hop between frames
    fmin: float = 60.0              # lowest expected freq (B1 ~61.7 Hz)
    fmax: float = 1200.0            # highest expected freq

    # Onset detection
    onset_threshold: float = 0.3    # energy rise threshold
    onset_hop_size: int = 512
    min_onset_interval_ms: float = 80.0  # min ms between onsets (anti-double-trigger)

    # Amplitude
    silence_threshold_db: float = -50.0  # below this = silence


@dataclass
class AnalysisConfig:
    """Analysis module configuration."""
    bpm: float = 120.0
    timing_tolerance_ms: float = 50.0   # within this = "on time"
    pitch_tolerance_cents: float = 50.0  # within this = "correct note"
    weak_dynamics_db: float = -45.0      # below this = "weak dynamics"
    timing_unstable_std_ms: float = 30.0 # std dev above this = "unstable"

import os
from dotenv import load_dotenv

load_dotenv()

@dataclass
class AIConfig:
    """Optional AI coaching layer."""
    enabled: bool = os.getenv("GEMINI_API_KEY") is not None
    api_key: Optional[str] = os.getenv("GEMINI_API_KEY")
    model: str = "gemini-1.5-flash"
    max_tokens: int = 300


@dataclass
class RecordingConfig:
    """Recording session configuration."""
    max_duration_s: float = 30.0   # hard upper limit


@dataclass
class AppConfig:
    """Top-level application config."""
    audio: AudioConfig = field(default_factory=AudioConfig)
    dsp: DSPConfig = field(default_factory=DSPConfig)
    analysis: AnalysisConfig = field(default_factory=AnalysisConfig)
    ai: AIConfig = field(default_factory=AIConfig)
    recording: RecordingConfig = field(default_factory=RecordingConfig)
    reference_pitch_hz: float = 440.0  # A4 tuning reference
