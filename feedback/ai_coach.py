"""Optional AI coaching layer — uses an LLM to generate natural coaching advice."""

import json
import time
from config import AIConfig


class AICoach:
    """Transforms structured feedback and raw audio into natural coaching advice using Gemini.

    Gracefully degrades if the API key is missing or the call fails.
    """

    SYSTEM_PROMPT = """You are a professional guitar teacher and audio engineer.

You are analyzing a student's guitar performance using:

1. Raw audio recording
2. DSP metrics (timing, pitch, dynamics)

Your job is to give precise, technical, and actionable feedback.

Rules:

* Do NOT give generic advice
* Focus on the biggest 2–3 mistakes
* Use concrete observations from the data
* Be concise but specific
* Give clear improvement steps

DSP DATA:

* Tempo: {bpm}
* Timing deviation: {timing_ms} ms avg
* Timing consistency: {timing_std}
* Pitch accuracy: {pitch_accuracy}%
* Detected issues: {issues_list}

After analyzing the audio and DSP data:

Output format:

1. Main Problems (bullet points)
2. Why it happens
3. How to fix (step-by-step)
4. Short encouragement

Speak like a real coach, not like an AI."""

    def __init__(self, config: AIConfig):
        self.config = config
        self._client = None

        if config.enabled and config.api_key:
            try:
                from google import genai
                self._client = genai.Client(api_key=config.api_key)
            except ImportError:
                print("[AICoach] google-genai package not installed")
            except Exception as e:
                print(f"[AICoach] Failed to init Gemini: {e}")

    @property
    def is_available(self) -> bool:
        return self._client is not None

    def evaluate_audio(self, wav_path: str, feedback_report_dict: dict, bpm: float = 120.0) -> str:
        """Generate AI coaching advice from a WAV file and a feedback report.

        Args:
            wav_path: path to the temporary .wav file
            feedback_report_dict: the FeedbackReport as a dict
            bpm: The metronome tempo used for the recording

        Returns:
            Natural language coaching advice.
        """
        if not self.is_available:
            return self._fallback(feedback_report_dict)

        try:
            errors = feedback_report_dict.get("errors", [])
            issues_str = "\n  - ".join([e["message"] for e in errors]) if errors else "None detected"

            prompt = self.SYSTEM_PROMPT.format(
                bpm=bpm,
                timing_ms=round(feedback_report_dict.get("timing_error_ms", 0), 1),
                timing_std=round(feedback_report_dict.get("timing_std_ms", 0), 1),
                pitch_accuracy=round(feedback_report_dict.get("accuracy_pct", 0), 1),
                issues_list=issues_str
            )
            
            # Upload the audio file to Gemini
            print(f"[AICoach] Uploading audio to Gemini: {wav_path}")
            audio_file = self._client.files.upload(file=wav_path)
            
            # We must wait until the file is completely processed by Gemini before generating
            while audio_file.state.name == "PROCESSING":
                time.sleep(1)
                audio_file = self._client.files.get(name=audio_file.name)
            
            if audio_file.state.name == "FAILED":
                raise ValueError("Gemini failed to process the audio file.")



            print("[AICoach] Generating advice...")
            response = self._client.models.generate_content(
                model=self.config.model,
                contents=[prompt, audio_file]
            )
            
            # Clean up the file from Google's servers
            try:
                self._client.files.delete(name=audio_file.name)
            except Exception as e:
                print(f"[AICoach] Warning: could not delete temporary file from Gemini: {e}")

            if response.text:
                return response.text.strip()
            return self._fallback(feedback_report_dict)

        except Exception as e:
            print(f"[AICoach] API call failed: {e}")
            return self._fallback(feedback_report_dict)

    def _fallback(self, report: dict) -> str:
        """Simple rule-based fallback when AI is unavailable."""
        tips = []
        messages = report.get("messages", [])

        if messages:
            tips.append("Based on your session:")
            for msg in messages[:3]:
                tips.append(f"  • {msg}")

        if not tips:
            tips.append("Keep practicing! Consistency is key to improvement.")

        return "\n".join(tips)
