"""Turn raw model output into a safe, structured Roxy response."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from .prompts import ANIMATIONS, EMOTIONS

_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]{1,200}>")
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_MD_RE = re.compile(r"[*_`#]{1,3}")
_WS_RE = re.compile(r"[ \t]{2,}")

EMOTION_TO_ANIMATION = {
    "happy": "happy",
    "excited": "happy",
    "sad": "idle",
    "surprised": "surprised",
    "confused": "thinking",
    "thinking": "thinking",
    "neutral": "talking",
}

MAX_TEXT_LENGTH = 4000


@dataclass
class ParsedResponse:
    text: str
    emotion: str = "neutral"
    animation: str = "talking"
    memory: dict[str, str] | None = None
    structured: bool = False
    meta: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {"text": self.text, "emotion": self.emotion, "animation": self.animation}


def sanitize_text(raw: str) -> str:
    """Strip anything that should never reach the DOM, TTS, or the logs."""
    text = _CTRL_RE.sub("", str(raw or ""))
    text = _TAG_RE.sub("", text)          # no HTML/script-ish fragments
    text = _FENCE_RE.sub("", text)
    text = _MD_RE.sub("", text)           # markdown noise reads badly aloud
    text = _WS_RE.sub(" ", text)
    text = "\n".join(line.strip() for line in text.splitlines())
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) > MAX_TEXT_LENGTH:
        text = text[:MAX_TEXT_LENGTH].rstrip() + "…"
    return text


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    candidate = _FENCE_RE.sub("", raw.strip())
    try:
        parsed = json.loads(candidate)
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        pass

    # Balanced-brace scan: tolerates prose wrapped around the JSON.
    start = candidate.find("{")
    while start != -1:
        depth, in_str, esc = 0, False, False
        for idx in range(start, len(candidate)):
            ch = candidate[idx]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        parsed = json.loads(candidate[start : idx + 1])
                        if isinstance(parsed, dict):
                            return parsed
                    except json.JSONDecodeError:
                        break
        start = candidate.find("{", start + 1)
    return None


def _coerce_memory(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    key = sanitize_text(value.get("key", ""))[:64]
    val = sanitize_text(value.get("value", ""))[:400]
    key = re.sub(r"[^a-z0-9_]+", "_", key.lower()).strip("_")
    if not key or not val:
        return None
    return {"key": key, "value": val}


def parse_response(raw: str) -> ParsedResponse:
    """Never raises. Falls back to neutral/talking with the raw text."""
    raw = raw or ""
    data = _extract_json_object(raw)

    if not data or not isinstance(data.get("text"), str) or not data["text"].strip():
        text = sanitize_text(raw)
        return ParsedResponse(
            text=text or "I'm here, but I didn't quite catch that. Could you say it again?",
            emotion="neutral",
            animation="talking",
            structured=False,
            meta={"fallback": "unstructured"},
        )

    text = sanitize_text(data["text"])
    emotion = str(data.get("emotion", "neutral")).strip().lower()
    animation = str(data.get("animation", "")).strip().lower()

    if emotion not in EMOTIONS:
        emotion = "neutral"
    if animation not in ANIMATIONS:
        animation = EMOTION_TO_ANIMATION.get(emotion, "talking")

    return ParsedResponse(
        text=text or "…",
        emotion=emotion,
        animation=animation,
        memory=_coerce_memory(data.get("memory")),
        structured=True,
    )
