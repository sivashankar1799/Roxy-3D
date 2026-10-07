"""Server-side wake-word configuration and matching.

The browser runs the actual detection today, but the phrase and the matching
rules live here so a native engine (Porcupine, openWakeWord, …) can be dropped
in behind the same interface without touching the frontend.
"""
from __future__ import annotations

import abc
import re
from dataclasses import dataclass

_PUNCT_RE = re.compile(r"[^a-z0-9 ]+")
_WS_RE = re.compile(r"\s+")

# Speech recognisers routinely mangle "roxy".
HOMOPHONES = {
    "roxy": ("roxy", "roxie", "roxi", "rocksy", "rocksie", "rocky", "roxxy", "rock c", "rock see"),
    "hey": ("hey", "hay", "a", "hi"),
}


def normalize_phrase(text: str) -> str:
    return _WS_RE.sub(" ", _PUNCT_RE.sub(" ", (text or "").lower())).strip()


@dataclass(frozen=True)
class WakeWordConfig:
    phrase: str = "hey roxy"
    sensitivity: float = 0.6
    enabled: bool = True

    def variants(self) -> list[str]:
        """Expand the phrase into plausible mis-transcriptions."""
        words = normalize_phrase(self.phrase).split()
        if not words:
            return []
        combos: list[list[str]] = [[]]
        for word in words:
            options = HOMOPHONES.get(word, (word,))
            combos = [prefix + [option] for prefix in combos for option in options]
        return sorted({" ".join(c) for c in combos})

    def to_client(self) -> dict:
        return {"phrase": self.phrase, "sensitivity": self.sensitivity,
                "enabled": self.enabled, "variants": self.variants()}


class WakeWordDetector(abc.ABC):
    """Swap-in point for a real local engine."""

    @abc.abstractmethod
    def detect(self, transcript: str) -> tuple[bool, str]:
        """Return (detected, trailing_command_text)."""


class TranscriptWakeWordDetector(WakeWordDetector):
    """Default: match the wake phrase inside an ASR transcript."""

    def __init__(self, config: WakeWordConfig) -> None:
        self.config = config
        self._variants = config.variants()

    def detect(self, transcript: str) -> tuple[bool, str]:
        text = normalize_phrase(transcript)
        if not text:
            return False, ""
        for variant in self._variants:
            index = text.find(variant)
            if index != -1:
                return True, text[index + len(variant) :].strip()
        return False, ""


def create_detector(config: WakeWordConfig) -> WakeWordDetector:
    return TranscriptWakeWordDetector(config)
