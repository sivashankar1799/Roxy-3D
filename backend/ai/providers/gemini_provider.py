"""Google Gemini provider (generativelanguage v1beta :generateContent)."""
from __future__ import annotations

from typing import Any

from ..prompts import ANIMATIONS, EMOTIONS
from .base import (
    AIProvider,
    ChatMessage,
    ProviderResponseError,
    ProviderUnavailableError,
)

RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "text": {"type": "STRING"},
        "emotion": {"type": "STRING", "enum": list(EMOTIONS)},
        "animation": {"type": "STRING", "enum": list(ANIMATIONS)},
        "memory": {
            "type": "OBJECT",
            "nullable": True,
            "properties": {"key": {"type": "STRING"}, "value": {"type": "STRING"}},
        },
    },
    "required": ["text", "emotion", "animation"],
    "propertyOrdering": ["text", "emotion", "animation", "memory"],
}


class GeminiProvider(AIProvider):
    name = "gemini"
    supports_structured_output = True

    DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"

    @property
    def url(self) -> str:
        base = (self.config.api_url or self.DEFAULT_BASE).rstrip("/")
        model = self.config.model or "gemini-2.5-flash"
        if ":generateContent" in base:
            return base
        if "/models/" in base:
            return f"{base}:generateContent"
        return f"{base}/models/{model}:generateContent"

    def _headers(self) -> dict[str, str]:
        return {"x-goog-api-key": self.config.api_key, "Content-Type": "application/json"}

    async def complete(self, system_prompt: str, messages: list[ChatMessage]) -> str:
        contents = [
            {"role": "model" if m.role == "assistant" else "user", "parts": [{"text": m.content}]}
            for m in messages
            if m.role in ("user", "assistant")
        ]
        body = {
            "contents": contents,
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "generationConfig": {
                "temperature": self.temperature,
                "maxOutputTokens": self.max_tokens,
                "responseMimeType": "application/json",
                "responseSchema": RESPONSE_SCHEMA,
            },
        }

        data = await self._post(self.url, headers=self._headers(), json_body=body)

        feedback = data.get("promptFeedback") or {}
        if feedback.get("blockReason"):
            raise ProviderUnavailableError(
                f"blocked: {feedback['blockReason']}",
                user_message="I'm not able to respond to that one. Let's talk about something else.",
            )

        candidates = data.get("candidates") or []
        if not candidates:
            raise ProviderResponseError("No candidates returned")

        candidate = candidates[0]
        finish = candidate.get("finishReason")
        parts = ((candidate.get("content") or {}).get("parts")) or []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()

        if not text:
            if finish in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"):
                raise ProviderUnavailableError(
                    f"finishReason={finish}",
                    user_message="I'd rather not answer that one.",
                )
            raise ProviderResponseError(f"Empty candidate (finishReason={finish})")
        return text
