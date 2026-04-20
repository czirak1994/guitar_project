"""Optional AI coaching layer — uses an LLM to generate natural coaching advice."""

import json
import time
from config import AIConfig


class AICoach:
    """Transforms structured feedback and raw audio into natural coaching advice using Gemini.

    Gracefully degrades if the API key is missing or the call fails.
    """

    SYSTEM_PROMPT = """You are a professional musical guitar coach (ToneSense AI).

You are analyzing a student's guitar performance by listening to their raw audio recording and reviewing DSP metrics.

Your job is to give highly constructive, musical, and technical feedback in JSON format.

Rules:
* You MUST carefully analyze the provided WAV audio file to detect the underlying Scale/Key and Rhythm.
* IF a backing track is provided, compare the student's playing to the backing track's harmony and tempo. Help them stay in key and 'in the pocket'.
* Speak like a real, encouraging music mentor.
* Be conversational in the 'musical_advice' field, focusing on phrasing, dynamics, and feel.
* Keep 'technical_focus' strictly limited to fixing the primary mechanical error based on DSP metrics.
* IF the student is out of tune or off-beat relative to the backing track, prioritize that in technical feedback.

USER CONTEXT:
* Skill Level: {skill_level}
* Goal: {goal}
* Language: {language} (You MUST write all generated text in this language!)

DSP DATA:
* Tempo: {bpm}
* Timing deviation: {timing_ms} ms avg
* Timing consistency: {timing_std}
* Pitch accuracy: {pitch_accuracy}%
* Detected issues: {issues_list}

PREVIOUS SESSION:
* Previous Timing: {last_timing_ms} ms
* Previous Accuracy: {last_pitch_accuracy}%

Output exact JSON strictly conforming to this schema:
{{
  "summary": "2-3 conversational sentences summarizing the overall feel and progress.",
  "detected_scale": "The likely scale/key they played (e.g. 'A Minor Pentatonic', 'C Major'). If unsure, guess the closest.",
  "detected_rhythm": "The primary rhythm pattern used (e.g. 'Straight 8th notes', 'Syncopated Triplets').",
  "musical_advice": "A conversational paragraph with ideas on phrasing, dynamics, or musicality to make it sound better.",
  "technical_focus": "The #1 DSP metric to fix (e.g., 'Timing was late by 30ms. Play on top of the beat')."
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

    def evaluate_audio(self, wav_path: str, feedback_report_dict: dict, bpm: float = 120.0, ai_context: dict = None, backing_track_path: str = None) -> dict:
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
            
            contents_list = [prompt]
            
            if backing_track_path and __import__('os').path.exists(backing_track_path):
                 print(f"[AICoach] Uploading backing track: {backing_track_path}")
                 bt_file = self._client.files.upload(file=backing_track_path)
                 contents_list.append("\nProvided below is the original backing track for reference:\n")
                 contents_list.append(bt_file)
                 contents_list.append("\nProvided below is the student's raw guitar recording playing over the track:\n")
                 contents_list.append(audio_file)
            else:
                 contents_list.append(audio_file)
            
            while audio_file.state.name == "PROCESSING":
                time.sleep(1)
                audio_file = self._client.files.get(name=audio_file.name)
            
            if audio_file.state.name == "FAILED":
                raise ValueError("Gemini failed to process the audio file.")

            from google.genai import types

            print("[AICoach] Generating advice...")
            
            for attempt in range(3):
                try:
                    response = self._client.models.generate_content(
                        model=self.config.model,
                        contents=contents_list,
                        config=types.GenerateContentConfig(
                            response_mime_type="application/json",
                        ),
                    )
                    
                    if response.text:
                        text = response.text.strip()
                        if text.startswith('```json'): text = text[7:]
                        if text.startswith('```'): text = text[3:]
                        if text.endswith('```'): text = text[:-3]
                        try:
                            result_data = json.loads(text.strip())
                            try:
                                self._client.files.delete(name=audio_file.name)
                                if backing_track_path:
                                     self._client.files.delete(name=bt_file.name)
                            except Exception:
                                pass
                            return result_data
                        except Exception as parse_e:
                            print(f"[AICoach] JSON Parse Error (Attempt {attempt+1}): {parse_e}")
                            if attempt == 2: raise parse_e
                except Exception as api_e:
                    print(f"[AICoach] API call attempt {attempt+1} failed: {api_e}")
                    if attempt == 2:
                        try:
                            self._client.files.delete(name=audio_file.name)
                            if backing_track_path: self._client.files.delete(name=bt_file.name)
                        except Exception:
                            pass
                        raise api_e
                    time.sleep(2)

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
            tips.append("Focus on improving your timing with a metronome.")
            
        return {
            "summary": "Great effort! The AI audio analysis timed out, but the basic engine detected some variations.",
            "detected_scale": "Unknown (Offline)",
            "detected_rhythm": "Unknown (Offline)",
            "musical_advice": "Try to focus on consistent dynamics and a flowing rhythm.",
            "technical_focus": tips[0] if tips else "Keep practicing with the metronome."
        }
