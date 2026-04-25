"""Optional AI coaching layer — uses an LLM to generate natural coaching advice."""

import json
import re
import time
from collections import Counter
from config import AIConfig


class AICoach:
    """Transforms structured feedback and raw audio into natural coaching advice using Gemini.

    Gracefully degrades if the API key is missing or the call fails.
    """

    SYSTEM_PROMPT = """You are an expert guitar teacher and audio analyst.

You are given:
1) A user-written description of their goal and problem
2) A guitar recording (audio)

Your job is to provide highly specific, actionable feedback.

---

USER INPUT:

Goal: {goal}
Problem: {user_problem}
Focus: {focus}
Style: {style}
Skill Level: {skill_level}
Language: {language}

---

INSTRUCTIONS:

1. Prioritize the USER'S GOAL over everything else.
2. Focus ONLY on the selected focus area. Do not give broad, generic feedback.
3. Analyze the audio carefully, but do NOT assume perfect accuracy.
4. If something is unclear or uncertain in the audio, explicitly say so.
5. Avoid generic phrases like "keep practicing" or "good job".
6. Give concrete, practical advice the user can apply immediately.
7. If relevant, suggest a short exercise tailored to the user's issue.
8. Keep the tone professional but direct (not overly motivational, not harsh).

---

AUDIO CONTEXT:

DSP Metrics:
* Tempo: {bpm}
* Timing deviation: {timing_ms} ms avg
* Timing consistency: {timing_std}
* Pitch accuracy: {pitch_accuracy}%
* Detected issues: {issues_list}

Note Analysis:
* Total detected notes: {note_count}
* Detected scale/key: {detected_scale}
* Detected rhythm: {detected_rhythm}

Progress:
* Previous timing: {last_timing_ms} ms
* Previous accuracy: {last_pitch_accuracy}%

---

OUTPUT FORMAT:

{{
  "diagnosis": "Short diagnosis (1–2 sentences explaining the core issue)",
  "specific_issues": ["Issue 1", "Issue 2", ...],
  "actionable_fixes": ["Fix 1", "Fix 2", ...],
  "focused_exercise": "Optional: 1 focused exercise tailored to the problem, or null if not applicable"
}}

---

IMPORTANT:

* Do NOT repeat the user's input
* Do NOT give general guitar theory unless directly relevant
* Do NOT comment on areas outside the selected focus
* If the audio is low quality, say it clearly and adjust confidence
* Write all output in: {language}
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

    def _build_meta(
        self,
        *,
        used_fallback: bool,
        stage: str,
        reason: str | None = None,
        uploaded_to_gemini: bool = False,
        youtube_context: bool = False,
    ) -> dict:
        return {
            "provider": "gemini",
            "used_fallback": used_fallback,
            "stage": stage,
            "reason": reason,
            "uploaded_to_gemini": uploaded_to_gemini,
            "youtube_context": youtube_context,
            "model": self.config.model,
        }

    def _with_meta(self, payload: dict, meta: dict) -> dict:
        result = dict(payload)
        result["_meta"] = meta
        return result

    def _build_note_profile(self, feedback_report_dict: dict) -> dict:
        notes = feedback_report_dict.get("notes") or []

        parsed_notes = []
        for note in notes:
            raw_note = note.get("note") if isinstance(note, dict) else None
            if not raw_note:
                continue
            match = re.match(r"^([A-G]#?\d)", raw_note)
            if match:
                parsed_notes.append(match.group(1))

        counts = Counter(parsed_notes)
        total = len(parsed_notes)
        unique = sorted(counts)
        top_notes = ", ".join(f"{name} x{count}" for name, count in counts.most_common(4)) or "None"

        practice_hint = "General playing"
        if total <= 8:
            practice_hint = "Very sparse take"
        if len(unique) <= 2 and total > 0:
            practice_hint = "Very limited melodic content"
        elif len(unique) <= 4:
            practice_hint = "Simple note pattern or picking exercise"

        return {
            "note_count": total,
            "unique_notes": ", ".join(unique) if unique else "None",
            "top_notes": top_notes,
            "practice_hint": practice_hint,
            "is_limited_material": total <= 8 or len(unique) <= 3,
        }

    def _apply_guardrails(self, advice: dict, note_profile: dict) -> dict:
        result = dict(advice)

        if not note_profile.get("is_limited_material"):
            return result

        # For new prompt format
        if "diagnosis" in result:
            result["diagnosis"] = (
                "This take contains only limited melodic information, so treat it as a simple picking exercise rather than a full musical phrase. "
                "Not enough evidence for confident key/scale analysis."
            )
            if "specific_issues" not in result:
                result["specific_issues"] = []
            if "actionable_fixes" not in result:
                result["actionable_fixes"] = ["Focus on consistent pick attack and timing", "Increase the length and complexity of the phrase for better feedback"]
            result["focused_exercise"] = "Record a longer phrase with clearer melodic movement for more targeted feedback."
        
        # Fallback for old format
        else:
            result["detected_scale"] = "Single-note exercise / not enough evidence"
            result["detected_rhythm"] = "Isolated note picking / no stable rhythmic motif detected"
            result["summary"] = (
                "This take contains only limited melodic information, so the safest reading is a simple picking exercise rather than a full musical phrase. "
                "There is not enough evidence here for a confident key or scale label."
            )
            result["musical_advice"] = (
                "Treat this as a technique check: focus on consistent pick attack, clean note separation, and steady pulse. "
                "For more musical coaching, record a longer phrase with clearer melodic movement."
            )
            technical_focus = result.get("technical_focus") or ""
            if "right notes" in technical_focus.lower():
                result["technical_focus"] = "Focus on consistency of attack, timing, and string noise control."

        return result

    def evaluate_audio(self, wav_path: str, feedback_report_dict: dict, bpm: float = 120.0, ai_context: dict = None, youtube_url: str = None) -> dict:
        if ai_context is None:
            ai_context = {}

        stage = "init"
        uploaded_to_gemini = False
        youtube_context = bool(youtube_url)

        if not self.is_available:
            return self._fallback(
                feedback_report_dict,
                reason="Gemini client unavailable.",
                meta=self._build_meta(
                    used_fallback=True,
                    stage=stage,
                    reason="Gemini client unavailable.",
                    uploaded_to_gemini=False,
                    youtube_context=youtube_context,
                ),
            )

        try:
            errors = feedback_report_dict.get("errors", [])
            issues_str = "\n  - ".join([e["message"] for e in errors]) if errors else "None detected"
            note_profile = self._build_note_profile(feedback_report_dict)

            prompt = self.SYSTEM_PROMPT.format(
                skill_level=ai_context.get("skill_level", "beginner"),
                goal=ai_context.get("goal", "general improvement"),
                user_problem=ai_context.get("problem", "Not specified"),
                focus=ai_context.get("focus", "overall"),
                style=ai_context.get("style", "Not specified"),
                language=ai_context.get("language", "English"),
                bpm=bpm,
                timing_ms=round(feedback_report_dict.get("timing_error_ms", 0), 1),
                timing_std=round(feedback_report_dict.get("timing_std_ms", 0), 1),
                pitch_accuracy=round(feedback_report_dict.get("accuracy_pct", 0), 1),
                issues_list=issues_str,
                note_count=note_profile["note_count"],
                detected_scale=feedback_report_dict.get("detected_scale", "Unknown"),
                detected_rhythm=feedback_report_dict.get("detected_rhythm", "Unknown"),
                last_timing_ms=ai_context.get("last_timing_error") or "N/A",
                last_pitch_accuracy=ai_context.get("last_accuracy") or "N/A"
            )
            
            stage = "upload"
            print(f"[AICoach] Uploading audio to Gemini: {wav_path}")
            audio_file = self._client.files.upload(file=wav_path)
            uploaded_to_gemini = True
            
            # Wait up to 30s for file to process
            wait_total = 0
            stage = "processing"
            while audio_file.state.name == "PROCESSING" and wait_total < 30:
                time.sleep(2)
                wait_total += 2
                audio_file = self._client.files.get(name=audio_file.name)
            
            if audio_file.state.name == "FAILED":
                print(f"[AICoach] Gemini rejected the audio file (state=FAILED). File may be silent, too short, or corrupted.")
                raise ValueError("Gemini rejected the audio file — likely too short or silent.")

            if audio_file.state.name == "PROCESSING":
                print(f"[AICoach] Gemini file still processing after timeout.")
                raise ValueError("Gemini audio processing timed out.")

            from google.genai import types

            prompt_parts = [prompt]
            if youtube_url:
                print(f"[AICoach] Adding YouTube URL as text context: {youtube_url}")
                prompt_parts.append(
                    "BACKING TRACK CONTEXT URL (reference only, not a file input): "
                    f"{youtube_url}\n"
                    "If this link is not usable, ignore it and analyze only the uploaded WAV plus DSP data."
                )

            combined_prompt = "\n\n".join(prompt_parts)

            contents_list = [
                combined_prompt,
                audio_file,
            ]
            
            print("[AICoach] Generating advice...")
            stage = "generation"
            
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
                            result_data = self._apply_guardrails(json.loads(text.strip()), note_profile)
                            try:
                                self._client.files.delete(name=audio_file.name)
                            except Exception:
                                pass
                            return self._with_meta(
                                result_data,
                                self._build_meta(
                                    used_fallback=False,
                                    stage="complete",
                                    uploaded_to_gemini=uploaded_to_gemini,
                                    youtube_context=youtube_context,
                                ),
                            )
                        except Exception as parse_e:
                            print(f"[AICoach] JSON Parse Error (Attempt {attempt+1}): {parse_e}")
                            if attempt == 2: raise parse_e
                except Exception as api_e:
                    print(f"[AICoach] API attempt {attempt+1} failed: {api_e}")
                    # If it's a rate limit or auth error, log it clearly
                    if "429" in str(api_e): print("[AICoach] Rate limited (2 RPM on Free Tier).")
                    if "401" in str(api_e) or "403" in str(api_e): print("[AICoach] Auth/API Key error.")
                    
                    if attempt == 2:
                        try:
                            self._client.files.delete(name=audio_file.name)
                        except Exception:
                            pass
                        raise api_e
                    time.sleep(2)

        except Exception as e:
            import traceback
            print(f"[AICoach] TOTAL FAILURE: {type(e).__name__}: {e}")
            print(traceback.format_exc())
            return self._fallback(
                feedback_report_dict,
                reason=str(e),
                meta=self._build_meta(
                    used_fallback=True,
                    stage=stage,
                    reason=str(e),
                    uploaded_to_gemini=uploaded_to_gemini,
                    youtube_context=youtube_context,
                ),
            )

    def _fallback(self, report: dict, reason: str = None, meta: dict | None = None) -> dict:
        tips = []
        messages = report.get("messages", [])

        if messages:
             for msg in messages[:2]:
                 tips.append(msg)

        if not tips:
            tips.append("Focus on improving your timing with a metronome.")

        # Give a more informative summary based on reason
        if reason and "silent" in reason.lower():
            summary = "No clear guitar signal detected — check your input level and try again."
        elif reason and ("timed out" in reason.lower() or "rejected" in reason.lower()):
            summary = "AI analysis could not process this take (audio too short or silent). Try a longer recording."
        else:
            summary = "AI coaching unavailable for this session. Your DSP metrics are still recorded."

        payload = {
            "summary": summary,
            "detected_scale": "Not Detected",
            "detected_rhythm": "Not Detected",
            "musical_advice": "Ensure your guitar is audible in the recording. The AI needs a clear signal to analyse your playing.",
            "technical_focus": tips[0] if tips else "Keep practicing with the metronome."
        }
        if meta is None:
            meta = self._build_meta(
                used_fallback=True,
                stage="fallback",
                reason=reason,
            )
        return self._with_meta(payload, meta)

    def _silence_fallback(self, report: dict) -> dict:
        return self._with_meta({
            "summary": "No guitar signal was detected in this recording.",
            "detected_scale": "N/A",
            "detected_rhythm": "N/A",
            "musical_advice": "Check your input volume and microphone connection. The AI needs to hear your playing clearly to analyze it.",
            "technical_focus": "Check cable/input gain."
        }, self._build_meta(
            used_fallback=True,
            stage="silence",
            reason="No audible guitar signal detected.",
            uploaded_to_gemini=False,
        ))
