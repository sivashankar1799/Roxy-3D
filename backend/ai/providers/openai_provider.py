"""OpenAI Chat Completions provider with JSON-schema structured outputs."""
from __future__ import annotations

from typing import Any

from ..prompts import ANIMATIONS, EMOTIONS
from .base import AIProvider, ChatMessage, ProviderResponseError

RESPONSE_SCHEMA: dict[str, Any] = {
    "name": "roxy_reply",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "text": {"type": "string"},
            "emotion": {"type": "string", "enum": list(EMOTIONS)},
            "animation": {"type": "string", "enum": list(ANIMATIONS)},
            "memory": {
                "type": ["object", "null"],
                "additionalProperties": False,
                "properties": {"key": {"type": "string"}, "value": {"type": "string"}},
                "required": ["key", "value"],
            },
        },
        "required": ["text", "emotion", "animation", "memory"],
    },
}


class OpenAIProvider(AIProvider):
    name = "openai"
    supports_structured_output = True

    DEFAULT_URL = "https://api.openai.com/v1/chat/completions"

    @property
    def url(self) -> str:
        url = self.config.api_url or self.DEFAULT_URL
        # Accept a bare base URL such as https://api.openai.com/v1
        if not url.rstrip("/").endswith("chat/completions"):
            url = url.rstrip("/") + "/chat/completions"
        return url

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }

    def _payload(self, system_prompt: str, messages: list[ChatMessage], *, minimal: bool) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.config.model or "gpt-4o-mini",
            "messages": [{"role": "system", "content": system_prompt}]
            + [{"role": m.role, "content": m.content} for m in messages],
            "response_format": {"type": "json_schema", "json_schema": RESPONSE_SCHEMA},
        }
        if not minimal:
            body["temperature"] = self.temperature
            body["max_tokens"] = self.max_tokens
        else:
            # Reasoning-style models reject `temperature`/`max_tokens`.
            body["max_completion_tokens"] = self.max_tokens
        return body

    async def complete(self, system_prompt: str, messages: list[ChatMessage]) -> str:
        try:
            data = await self._post(
                self.url, headers=self._headers(), json_body=self._payload(system_prompt, messages, minimal=False)
            )
        except ProviderResponseError:
            # One retry with a parameter set that newer models accept.
            data = await self._post(
                self.url, headers=self._headers(), json_body=self._payload(system_prompt, messages, minimal=True)
            )

        try:
            choice = data["choices"][0]
            content = choice["message"].get("content")
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderResponseError(f"Unexpected payload shape: {str(data)[:200]}") from exc

        if isinstance(content, list):  # some gateways return content parts
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        if not content:
            raise ProviderResponseError("Empty completion returned")
        return str(content)
