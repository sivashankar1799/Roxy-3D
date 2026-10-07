"""Optional server-side TTS. Default is 'none' (the browser speaks)."""
from __future__ import annotations

import abc
import base64
from dataclasses import dataclass

import httpx

from ..config import Settings
from ..utils.logger import get_logger

logger = get_logger("tts")


@dataclass
class TTSResult:
    audio: bytes
    mime: str = "audio/mpeg"

    def to_base64(self) -> str:
        return base64.b64encode(self.audio).decode("ascii")


class TTSEngine(abc.ABC):
    name = "none"
    available = False

    @abc.abstractmethod
    async def synthesize(self, text: str, *, voice: str | None = None, speed: float = 1.0) -> TTSResult | None: ...

    async def aclose(self) -> None:  # pragma: no cover - default no-op
        return None


class NullTTS(TTSEngine):
    """Signals the frontend to use the Web Speech API instead."""

    name = "none"
    available = False

    async def synthesize(self, text: str, *, voice: str | None = None, speed: float = 1.0) -> None:
        return None


class OpenAITTS(TTSEngine):
    name = "openai"
    available = True
    URL = "https://api.openai.com/v1/audio/speech"

    def __init__(self, api_key: str, model: str, voice: str, timeout: float = 30.0) -> None:
        self.api_key = api_key
        self.model = model
        self.voice = voice
        self.timeout = timeout
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def synthesize(self, text: str, *, voice: str | None = None, speed: float = 1.0) -> TTSResult | None:
        text = (text or "").strip()[:4000]
        if not text or not self.api_key:
            return None
        try:
            response = await self._get_client().post(
                self.URL,
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={
                    "model": self.model,
                    "voice": voice or self.voice,
                    "input": text,
                    "speed": max(0.25, min(4.0, speed)),
                    "response_format": "mp3",
                },
            )
            if not response.is_success:
                logger.warning("TTS failed: HTTP %s", response.status_code)
                return None
            return TTSResult(audio=response.content, mime="audio/mpeg")
        except httpx.HTTPError as exc:
            logger.warning("TTS transport error: %s", exc)
            return None

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()


def create_tts_engine(settings: Settings) -> TTSEngine:
    if settings.tts_provider == "openai":
        key = settings.provider_config("openai").api_key
        if key:
            logger.info("Server-side TTS enabled (openai/%s)", settings.tts_voice)
            return OpenAITTS(key, settings.tts_model, settings.tts_voice, settings.timeout)
        logger.warning("TTS_PROVIDER=openai but no OpenAI key found; falling back to browser TTS")
    return NullTTS()
