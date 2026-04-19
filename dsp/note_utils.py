"""Note utility functions — frequency ↔ note conversion.

Uses 12-TET tuning with configurable A4 reference (default 440 Hz).
"""

import math

# Note names in chromatic order
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Guitar string standard tuning (for reference)
GUITAR_STANDARD = {
    "E2": 82.41,
    "A2": 110.00,
    "D3": 146.83,
    "G3": 196.00,
    "B3": 246.94,
    "E4": 329.63,
}


def freq_to_midi(freq_hz: float, a4: float = 440.0) -> float:
    """Convert frequency to MIDI note number (can be fractional)."""
    if freq_hz <= 0:
        return 0.0
    return 69.0 + 12.0 * math.log2(freq_hz / a4)


def midi_to_freq(midi_note: float, a4: float = 440.0) -> float:
    """Convert MIDI note number to frequency."""
    return a4 * (2.0 ** ((midi_note - 69.0) / 12.0))


def freq_to_note(freq_hz: float, a4: float = 440.0) -> tuple[str, int, float]:
    """Convert frequency to nearest note name, octave, and cents deviation.

    Args:
        freq_hz: frequency in Hz
        a4: reference pitch for A4

    Returns:
        (note_name, octave, cents_deviation)
        - note_name: e.g. "A", "C#"
        - octave: e.g. 4
        - cents_deviation: signed, range roughly [-50, +50]
    """
    if freq_hz <= 0:
        return ("", -1, 0.0)

    midi = freq_to_midi(freq_hz, a4)
    midi_rounded = round(midi)
    cents = (midi - midi_rounded) * 100.0

    note_index = midi_rounded % 12
    octave = (midi_rounded // 12) - 1  # MIDI octave convention

    return NOTE_NAMES[note_index], octave, round(cents, 2)


def note_to_freq(note_name: str, octave: int, a4: float = 440.0) -> float:
    """Convert note name and octave to frequency.

    Args:
        note_name: e.g. "A", "C#", "Bb" (Bb → A#)
        octave: e.g. 4

    Returns:
        frequency in Hz
    """
    # Normalize flats to sharps
    flat_to_sharp = {
        "Db": "C#", "Eb": "D#", "Fb": "E", "Gb": "F#",
        "Ab": "G#", "Bb": "A#", "Cb": "B",
    }
    name = flat_to_sharp.get(note_name, note_name)

    if name not in NOTE_NAMES:
        raise ValueError(f"Unknown note: {note_name}")

    note_index = NOTE_NAMES.index(name)
    midi = (octave + 1) * 12 + note_index
    return midi_to_freq(midi, a4)


def freq_to_note_string(freq_hz: float, a4: float = 440.0) -> str:
    """Convert frequency to a display string like 'A4 (+5c)' or 'C#3 (-12c)'."""
    if freq_hz <= 0:
        return "—"
    name, octave, cents = freq_to_note(freq_hz, a4)
    sign = "+" if cents >= 0 else ""
    return f"{name}{octave} ({sign}{cents:.0f}c)"


def cents_between(freq1: float, freq2: float) -> float:
    """Calculate the interval in cents between two frequencies."""
    if freq1 <= 0 or freq2 <= 0:
        return 0.0
    return 1200.0 * math.log2(freq2 / freq1)
