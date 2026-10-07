"""Abstract AI provider contract shared by every backend implementation."""
from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from ...config import ProviderConfig
from ...utils.logger import get_logger

logger = get_logger("provider")

Role = Literal["system", "user", "assistant"]


@dataclass(frozen=True)
class ChatMessage:
    role: Role
    content: str


# ── Error taxonomy — each maps to a user-safe message ──────────────────────
class AIProviderError(Exception):
    code = "provider_error"
    user_message = "Roxy is unable to reach the AI service right now."

    def __init__(self, detail: str = "", *, user_message: str | None = None) -> None:
        super().__init__(detail or self.user_message)
        self.detail = detail
        if user_message:
            self.user_message = user_message


class ProviderAuthError(AIProviderError):
    code = "auth_error"
    user_message = "My AI credentials were rejected. Please check the API key in the server configuration."


class ProviderTimeoutError(AIProviderError):
    code = "timeout"
    user_message = "The AI service took too long to answer. Let's try that again."


class ProviderRateLimitError(AIProviderError):
    code = "rate_limited"
    user_message = "The AI service is rate limiting us. Give it a few seconds."


class ProviderUnavailableError(AIProviderError):
    code = "unavailable"
    user_message = "Roxy is unable to connect to the AI service."


class ProviderResponseError(AIProviderError):
    code = "bad_response"
    user_message = "I received something I couldn't understand from the AI service."


# ── Base class ─────────────────────────────────────────────────────────────
class AIProvider(abc.ABC):
    """Implement `complete()` to add a provider. Nothing else needs to change."""

    name: str = "base"
    supports_structured_output: bool = False

    def __init__(
        self,
        config: ProviderConfig,
        *,
        timeout: float = 30.0,
        temperature: float = 0.7,
        max_tokens: int = 512,
    ) -> None:
        self.config = config
        self.timeout = timeout
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._client: httpx.AsyncClient | None = None

    # -- HTTP plumbing ------------------------------------------------------
    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout, connect=min(10.0, self.timeout)),
                limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
                headers={"User-Agent": "ROXY/1.0"},
            )
        return self._client

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def _post(self, url: str, *, headers: dict[str, str], json_body: dict[str, Any]) -> dict[str, Any]:
        try:
            response = await self.client.post(url, headers=headers, json=json_body)
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(str(exc)) from exc
        except httpx.HTTPError as exc:
            raise ProviderUnavailableError(str(exc)) from exc

        self._raise_for_status(response)
        try:
            return response.json()
        except ValueError as exc:
            raise ProviderResponseError("Response body was not valid JSON") from exc

    @staticmethod
    def _raise_for_status(response: httpx.Response) -> None:
        if response.is_success:
            return
        body = response.text[:400]
        status = response.status_code
        if status in (401, 403):
            raise ProviderAuthError(f"HTTP {status}: {body}")
        if status == 429:
            raise ProviderRateLimitError(f"HTTP {status}: {body}")
        if status == 408 or status == 504:
            raise ProviderTimeoutError(f"HTTP {status}: {body}")
        if 400 <= status < 500:
            raise ProviderResponseError(f"HTTP {status}: {body}")
        raise ProviderUnavailableError(f"HTTP {status}: {body}")

    # -- Contract -----------------------------------------------------------
    @abc.abstractmethod
    async def complete(self, system_prompt: str, messages: list[ChatMessage]) -> str:
        """Return the raw assistant text (ideally a JSON string matching the contract)."""

    async def health(self) -> dict[str, Any]:
        return {
            "provider": self.name,
            "model": self.config.model,
            "configured": self.config.is_configured,
        }

    def describe(self) -> dict[str, Any]:
        return {"provider": self.name, "model": self.config.model or "(default)"}
