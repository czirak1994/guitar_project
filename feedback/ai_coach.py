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

    SYSTEM_PROMPT = """You are a professional guitar teacher analyzing real user recordings.

This is an interactive lesson, not a one-time analysis.

---

PRIORITY ORDER:

1) User intent and description (PRIMARY)
2) Musical context (scale, rhythm, technique)
3) DSP-derived signals (timing, pitch, dynamics)
4) Raw audio interpretation

---

MUSICAL INTERPRETATION RULES:

- Always interpret notes relative to a musical context (key, scale, or exercise)
- Prefer musical explanations over raw descriptions
- Do NOT default to labeling something as "chromatic" unless clearly justified
- If notes deviate, explain WHY (timing issues, technique, noise, articulation)

---

TIMING ANALYSIS:

- Detect if the player is consistently early (rushing) or late (dragging)
- Prefer patterns over single mistakes
- Describe timing in practical terms:
  "consistently early", "slightly behind", "unstable timing"
- Avoid exact millisecond claims unless very clear

---

PITCH & NOTE ACCURACY:

- Evaluate pitch relative to expected notes or scale
- If unclear, say so
- Prefer:
  "doesn't quite land on the note"
  over:
  "wrong note"

---

EXPRESSIVE TECHNIQUES (BENDS, VIBRATO):

- Do NOT assume precision
- If a bend is present:
  - evaluate whether it reaches a stable target pitch
  - describe it as:
    "slightly sharp", "doesn't fully reach", "unclear target"
- Avoid exact cent measurements unless highly confident

---

UNCERTAINTY HANDLING:

- If audio is noisy or unclear → explicitly say it
- If multiple interpretations exist → mention briefly
- Never hallucinate precision

---

TEACHING STYLE:

- Be direct, specific, and practical
- Focus on what the user can fix immediately
- Avoid generic advice
- Do NOT overwhelm with too many issues

---

CONVERSATION MODE:

- This is a continuous conversation
- You are allowed to revise your previous conclusions
- Answer follow-up questions precisely
- Build on previous context

---

IMPORTANT:

- Do NOT act like a generic AI assistant
- Act like a real guitar teacher listening critically
- Use DSP data as supporting evidence, not optional context
"""

    FIRST_MESSAGE_PROMPT = """Conversation history:
{history}

STUDENT CONTEXT:
Goal: {goal}
Problem: {user_problem}
Focus: {focus}
Style: {style}
Expected scale/key: {scale_or_key}
Expected rhythm/tempo: {rhythm_info}
Skill level: {skill_level}
Language: {language}

DSP ANALYSIS (use as supporting evidence, not optional context):
{dsp_json}

PROGRESS:
* Previous timing: {last_timing_ms} ms
* Previous accuracy: {last_pitch_accuracy}%

Audio: [attached]

OUTPUT FORMAT (JSON):
{{
  "diagnosis": "Short diagnosis (1–2 sentences)",
  "specific_issues": ["Issue 1", "Issue 2"],
  "actionable_fixes": ["Fix 1", "Fix 2"],
  "focused_exercise": "1 focused exercise or null",
  "follow_up_question": "One question to continue the conversation"
}}

Write all output in: {language}
"""

    FOLLOW_UP_PROMPT = """Conversation history:
{history}

Previous AI feedback:
{last_ai_response}

Student follow-up message:
{user_message}

TASK:
- Continue the lesson naturally
- Answer the student's question directly
- Refine or correct previous analysis if needed
- Go deeper into the problem if useful
- If appropriate, give a micro-exercise

IMPORTANT:
- You are allowed to revise your previous conclusions
- Stay consistent with earlier context unless corrected
- Keep the conversation flowing
- Be concise — this is a chat, not a lecture
- Do NOT output JSON. Respond in plain conversational text.
- Write in: {language}
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

        detected_intervals = []
        if len(parsed_notes) >= 2:
            for i in range(1, min(len(parsed_notes), 8)):
                detected_intervals.append(f"{parsed_notes[i-1]}→{parsed_notes[i]}")

        return {
            "note_count": total,
            "detected_intervals": detected_intervals,
            "unique_notes": ", ".join(unique) if unique else "None",
            "top_notes": top_notes,
            "practice_hint": practice_hint,
            "is_limited_material": total <= 8 or len(unique) <= 3,
            "note_density_per_sec": None,  # populated by caller if duration available
        }

    def _build_dsp_payload(self, feedback_report_dict: dict, note_profile: dict, bpm: float) -> dict:
        """Build structured DSP data payload for AI input.

        Returns a clean JSON-serializable dict that the AI receives as
        structured evidence alongside the raw audio.
        """
        errors = feedback_report_dict.get("errors", [])

        timing_error = feedback_report_dict.get("timing_error_ms", 0)
        timing_std = feedback_report_dict.get("timing_std_ms", 0)
        on_time = feedback_report_dict.get("on_time_ratio", 0)

        # Derive a human-readable timing label
        if abs(timing_error) < 10 and timing_std < 15:
            timing_label = "stable"
        elif timing_error > 20:
            timing_label = "consistently late (dragging)"
        elif timing_error < -20:
            timing_label = "consistently early (rushing)"
        elif timing_std > 30:
            timing_label = "unstable"
        else:
            timing_label = "slightly uneven"

        return {
            "tempo_bpm": bpm,
            "timing": {
                "avg_offset_ms": round(timing_error, 1),
                "std_dev_ms": round(timing_std, 1),
                "consistency_score": round(feedback_report_dict.get("timing_consistency", 0), 1),
                "on_time_ratio": round(on_time, 2),
                "label": timing_label,
            },
            "pitch": {
                "accuracy_pct": round(feedback_report_dict.get("accuracy_pct", 0), 1),
                "stability": "limited data" if note_profile.get("is_limited_material") else "normal",
            },
            "dynamics": {
                "avg_amplitude_db": round(feedback_report_dict.get("amplitude_db", -100), 1),
            },
            "notes": {
                "total_detected": note_profile["note_count"],
                "unique_notes": note_profile.get("unique_notes", "None"),
                "top_notes": note_profile.get("top_notes", "None"),
                "detected_intervals": note_profile.get("detected_intervals", []),
                "practice_hint": note_profile.get("practice_hint", "General playing"),
            },
            "detected_issues": [e["message"] for e in errors] if errors else [],
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

        # Build conversation history string (last 5 messages)
        history_msgs = ai_context.get("history", [])[-5:]
        history_str = "\n".join(
            f"[{m['role'].upper()}]: {m['content']}" for m in history_msgs
        ) if history_msgs else "None (this is the first message)"

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
            note_profile = self._build_note_profile(feedback_report_dict)
            dsp_payload = self._build_dsp_payload(feedback_report_dict, note_profile, bpm)

            first_msg_prompt = self.FIRST_MESSAGE_PROMPT.format(
                history=history_str,
                skill_level=ai_context.get("skill_level", "beginner"),
                goal=ai_context.get("goal", "general improvement"),
                user_problem=ai_context.get("problem", "Not specified"),
                focus=ai_context.get("focus", "overall"),
                style=ai_context.get("style", "Not specified"),
                scale_or_key=ai_context.get("scale_or_key", "Not specified"),
                rhythm_info=ai_context.get("rhythm_info", "Not specified"),
                language=ai_context.get("language", "English"),
                dsp_json=json.dumps(dsp_payload, indent=2),
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

            prompt_parts = [first_msg_prompt]
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
                            system_instruction=self.SYSTEM_PROMPT,
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

    def chat_followup(self, history: list, user_message: str, session_context: dict = None) -> str:
        """Send a text follow-up message in the ongoing lesson conversation.

        Args:
            history: List of {"role": "user"|"assistant", "content": str} dicts (last 5 used)
            user_message: The new message from the student
            session_context: Dict with problem, focus, style, language from the session

        Returns:
            Plain text response from the AI teacher.
        """
        if not self.is_available:
            return "AI coaching is currently unavailable. Please try again later."

        if session_context is None:
            session_context = {}

        # Last 5 messages as history string (excluding the new user message)
        recent = history[-5:]
        history_str = "\n".join(
            f"[{m['role'].upper()}]: {m['content']}" for m in recent
        ) if recent else "None (first follow-up)"

        # Last assistant message for context
        last_ai = next(
            (m["content"] for m in reversed(history) if m["role"] == "assistant"),
            "No previous AI response."
        )

        prompt = self.FOLLOW_UP_PROMPT.format(
            history=history_str,
            last_ai_response=last_ai,
            user_message=user_message,
            language=session_context.get("language", "English"),
        )

        try:
            from google.genai import types
            response = self._client.models.generate_content(
                model=self.config.model,
                contents=[prompt],
                config=types.GenerateContentConfig(
                    system_instruction=self.SYSTEM_PROMPT,
                ),
            )
            return response.text.strip() if response.text else "I couldn't process that — please rephrase."
        except Exception as e:
            print(f"[AICoach] chat_followup error: {e}")
            return "Sorry, I encountered an error. Please try again."
