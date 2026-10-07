"""AI provider registry — swap providers via configuration, never via the frontend."""
from __future__ import annotations

from ...config import ProviderConfig, Settings
from .base import (
    AIProvider,
    AIProviderError,
    ChatMessage,
    ProviderAuthError,
    ProviderRateLimitError,
    ProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from .custom_provider import CustomProvider, MockProvider
from .gemini_provider import GeminiProvider
from .openai_provider import OpenAIProvider

REGISTRY: dict[str, type[AIProvider]] = {
    "openai": OpenAIProvider,
    "gemini": GeminiProvider,
    "custom": CustomProvider,
    "mock": MockProvider,
}


def create_provider(config: ProviderConfig, settings: Settings) -> AIProvider:
    cls = REGISTRY.get(config.name, MockProvider)
    if not config.is_configured:
        cls = MockProvider
        config = ProviderConfig(name="mock", api_key="", api_url="", model="roxy-offline")
    return cls(
        config=config,
        timeout=settings.timeout,
        temperature=settings.temperature,
        max_tokens=settings.max_tokens,
    )


__all__ = [
    "AIProvider",
    "AIProviderError",
    "ChatMessage",
    "CustomProvider",
    "GeminiProvider",
    "MockProvider",
    "OpenAIProvider",
    "ProviderAuthError",
    "ProviderRateLimitError",
    "ProviderResponseError",
    "ProviderTimeoutError",
    "ProviderUnavailableError",
    "REGISTRY",
    "create_provider",
]
