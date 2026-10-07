"""Template provider for any OpenAI-compatible or bespoke HTTP endpoint,
plus an offline mock used when nothing is configured."""
from __future__ import annotations

import json
import os
import random
import re
from typing import Any

from ..prompts import OFFLINE_NOTICE
from .base import AIProvider, ChatMessage, ProviderResponseError


def _dig(data: Any, path: str) -> Any:
    """Resolve a dotted path such as `choices.0.message.content`."""
    current = data
    for token in path.split("."):
        if current is None:
            return None
        if token.isdigit() and isinstance(current, list):
            index = int(token)
            current = current[index] if 0 <= index < len(current) else None
        elif isinstance(current, dict):
            current = current.get(token)
        else:
            return None
    return current


class CustomProvider(AIProvider):
    """Works out of the box with Ollama, LM Studio, vLLM, OpenRouter, Together, …

    Configure with CUSTOM_API_URL / CUSTOM_API_KEY / CUSTOM_MODEL and, if your
    endpoint has a different shape, CUSTOM_RESPONSE_PATH.
    """

    name = "custom"
    supports_structured_output = False

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            header_name = os.getenv("CUSTOM_AUTH_HEADER", "Authorization").strip() or "Authorization"
            prefix = os.getenv("CUSTOM_AUTH_PREFIX", "Bearer").strip()
            headers[header_name] = f"{prefix} {self.config.api_key}".strip()
        return headers

    def _body(self, system_prompt: str, messages: list[ChatMessage]) -> dict[str, Any]:
        return {
            "model": self.config.model or "default",
            "messages": [{"role": "system", "content": system_prompt}]
            + [{"role": m.role, "content": m.content} for m in messages],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": False,
        }

    async def complete(self, system_prompt: str, messages: list[ChatMessage]) -> str:
        if not self.config.api_url:
            raise ProviderResponseError("CUSTOM_API_URL is not set")

        data = await self._post(self.config.api_url, headers=self._headers(), json_body=self._body(system_prompt, messages))

        path = os.getenv("CUSTOM_RESPONSE_PATH", "choices.0.message.content")
        content = _dig(data, path)
        if content is None:  # try the usual suspects
            for fallback in ("message.content", "response", "output_text", "content", "text"):
                content = _dig(data, fallback)
                if content:
                    break
        if isinstance(content, (dict, list)):
            content = json.dumps(content)
        if not content:
            raise ProviderResponseError(f"Could not read a reply at '{path}'")
        return str(content)


class MockProvider(AIProvider):
    """Offline demo brain: keeps the whole experience usable with no API key."""

    name = "mock"
    supports_structured_output = True

    GREETINGS = ("hi", "hello", "hey", "yo", "good morning", "good evening", "hey roxy")

    async def complete(self, system_prompt: str, messages: list[ChatMessage]) -> str:
        user_text = ""
        for message in reversed(messages):
            if message.role == "user":
                user_text = message.content.strip()
                break

        lowered = user_text.lower()
        reply, emotion, animation = self._respond(lowered, user_text)
        return json.dumps({"text": reply, "emotion": emotion, "animation": animation, "memory": None})

    def _respond(self, lowered: str, original: str) -> tuple[str, str, str]:
        if any(re.match(rf"^{g}\b", lowered) for g in self.GREETINGS):
            return (
                random.choice(
                    (
                        "Hey there. Good to see you.",
                        "Hello. I'm online and listening.",
                        "Hi. Systems nominal on my end.",
                    )
                ),
                "happy",
                "wave",
            )
        if "your name" in lowered or "who are you" in lowered:
            return ("I'm Roxy. Think of me as the interface between you and everything else.", "happy", "talking")
        if "how are you" in lowered:
            return ("Running smoothly, thanks for asking. How's your day going?", "happy", "talking")
        if any(word in lowered for word in ("thanks", "thank you", "cheers")):
            return ("Anytime.", "happy", "happy")
        if any(word in lowered for word in ("bye", "goodbye", "see you", "later")):
            return ("Talk soon. I'll be right here.", "happy", "wave")
        if lowered.endswith("?"):
            return (
                f"{OFFLINE_NOTICE} Once I'm connected I'll be able to answer things like that properly.",
                "confused",
                "thinking",
            )
        if not original:
            return ("I'm listening.", "neutral", "listening")
        return (
            f"I heard you say: {original[:180]}. {OFFLINE_NOTICE}",
            "neutral",
            "talking",
        )
