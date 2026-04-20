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
3. Previous session data (to track progress)

Your job is to give precise, technical, and actionable feedback in JSON format.

Rules:
* Do NOT give generic advice. Do NOT give textual vomit.
* Follow the JSON structure strictly.
* Speak like a real coach, but extremely concise.
* Use concrete observations from the data (e.g. "Your timing improved by 10ms").

USER CONTEXT:
* Skill Level: {skill_level}
* Goal: {goal}
* Language: {language} (You MUST write the JSON string values in this language!)

DSP DATA:
* Tempo: {bpm}
* Timing deviation: {timing_ms} ms avg
* Timing consistency: {timing_std}
* Pitch accuracy: {pitch_accuracy}%
* Detected issues: {issues_list}

PREVIOUS SESSION:
* Previous Timing deviation: {last_timing_ms} ms avg
* Previous Pitch accuracy: {last_pitch_accuracy}%

Output exact JSON strictly conforming to this schema (no markdown formatting around it!):
{{
  "summary": "1 sentence summarizing progress (e.g., 'You improved your timing consistency, but are still rushing on the downbeat.')",
  "problem": "1 main problem (max 10 words)",
  "cause": "1 main cause of the problem (max 10 words)",
  "fix": [
     "Step 1 to fix the problem",
     "Step 2 (optional)"
  ],
  "encouragement": "Short 1 sentence encouragement."
}}
"""

    def __init__(self, config: AIConfig):
        self.config = config
        self._client = None

        if config.enabled and config.api_key:
            try:
                from google import genai
                from google.genai import types
                self._client = genai.Client(api_key=config.api_key)
            except ImportError:
                print("[AICoach] google-genai package not installed")
            except Exception as e:
                print(f"[AICoach] Failed to init Gemini: {e}")

    @property
    def is_available(self) -> bool:
        return self._client is not None

    def evaluate_audio(self, wav_path: str, feedback_report_dict: dict, bpm: float = 120.0, ai_context: dict = None) -> dict:
        if ai_context is None:
            ai_context = {}

        if not self.is_available:
            return self._fallback(feedback_report_dict)

        try:
            errors = feedback_report_dict.get("errors", [])
            issues_str = "\n  - ".join([e["message"] for e in errors]) if errors else "None detected"

            prompt = self.SYSTEM_PROMPT.format(
                skill_level=ai_context.get("skill_level", "beginner"),
                goal=ai_context.get("goal", "general improvement"),
                language=ai_context.get("language", "English"),
                bpm=bpm,
                timing_ms=round(feedback_report_dict.get("timing_error_ms", 0), 1),
                timing_std=round(feedback_report_dict.get("timing_std_ms", 0), 1),
                pitch_accuracy=round(feedback_report_dict.get("accuracy_pct", 0), 1),
                issues_list=issues_str,
                last_timing_ms=ai_context.get("last_timing_error") or "N/A",
                last_pitch_accuracy=ai_context.get("last_accuracy") or "N/A"
            )
            
            print(f"[AICoach] Uploading audio to Gemini: {wav_path}")
            audio_file = self._client.files.upload(file=wav_path)
            
            while audio_file.state.name == "PROCESSING":
                time.sleep(1)
                audio_file = self._client.files.get(name=audio_file.name)
            
            if audio_file.state.name == "FAILED":
                raise ValueError("Gemini failed to process the audio file.")

            from google.genai import types

            print("[AICoach] Generating advice...")
            response = self._client.models.generate_content(
                model=self.config.model,
                contents=[prompt, audio_file],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                ),
            )
            
            try:
                self._client.files.delete(name=audio_file.name)
            except Exception as e:
                pass

            if response.text:
                return json.loads(response.text.strip())
            return self._fallback(feedback_report_dict)

        except Exception as e:
            print(f"[AICoach] API call failed: {e}")
            return self._fallback(feedback_report_dict)

    def _fallback(self, report: dict) -> dict:
        tips = []
        messages = report.get("messages", [])

        if messages:
             for msg in messages[:2]:
                 tips.append(msg)

        if not tips:
            tips.append("Practice to a metronome.")
            
        return {
            "summary": "Keep practicing! Consistency is key.",
            "problem": "Timing variations.",
            "cause": "Lack of synchronization.",
            "fix": tips,
            "encouragement": "You'll get there!"
        }
