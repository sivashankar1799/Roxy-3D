"""Optional server-side STT. Default is 'none' (browser Web Speech API)."""
from __future__ import annotations

import abc

import httpx

from ..config import Settings
from ..utils.logger import get_logger

logger = get_logger("stt")

MAX_AUDIO_BYTES = 8 * 1024 * 1024


class STTEngine(abc.ABC):
    name = "none"
    available = False

    @abc.abstractmethod
    async def transcribe(self, audio: bytes, mime: str = "audio/webm") -> str | None: ...

    async def aclose(self) -> None:  # pragma: no cover
        return None


class NullSTT(STTEngine):
    async def transcribe(self, audio: bytes, mime: str = "audio/webm") -> None:
        return None


class OpenAISTT(STTEngine):
    name = "openai"
    available = True
    URL = "https://api.openai.com/v1/audio/transcriptions"

    def __init__(self, api_key: str, model: str, timeout: float = 45.0) -> None:
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def transcribe(self, audio: bytes, mime: str = "audio/webm") -> str | None:
        if not audio or len(audio) > MAX_AUDIO_BYTES or not self.api_key:
            return None
        suffix = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3"}.get(mime, "webm")
        try:
            response = await self._get_client().post(
                self.URL,
                headers={"Authorization": f"Bearer {self.api_key}"},
                files={"file": (f"speech.{suffix}", audio, mime)},
                data={"model": self.model},
            )
            if not response.is_success:
                logger.warning("STT failed: HTTP %s", response.status_code)
                return None
            return (response.json() or {}).get("text")
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("STT error: %s", exc)
            return None

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()


def create_stt_engine(settings: Settings) -> STTEngine:
    if settings.stt_provider == "openai":
        key = settings.provider_config("openai").api_key
        if key:
            return OpenAISTT(key, settings.stt_model, settings.timeout)
        logger.warning("STT_PROVIDER=openai but no OpenAI key found; using browser STT")
    return NullSTT()
