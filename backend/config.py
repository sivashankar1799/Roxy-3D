"""Central configuration. All secrets are read from the environment only."""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"

# backend/.env wins over a root .env; never override real environment variables.
for _candidate in (BACKEND_DIR / ".env", PROJECT_ROOT / ".env"):
    if _candidate.is_file():
        load_dotenv(_candidate, override=False, encoding="utf-8-sig")


def _s(name: str, default: str = "") -> str:
    raw = os.getenv(name)
    return raw.strip() if raw and raw.strip() else default


def _b(name: str, default: bool = False) -> bool:
    raw = _s(name)
    if not raw:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def _i(name: str, default: int) -> int:
    try:
        return int(float(_s(name, str(default))))
    except ValueError:
        return default


def _f(name: str, default: float) -> float:
    try:
        return float(_s(name, str(default)))
    except ValueError:
        return default


def _list(name: str, default: str = "*") -> list[str]:
    return [p.strip() for p in _s(name, default).split(",") if p.strip()]


PLACEHOLDERS = {
    "your_api_key_here",
    "your_api_endpoint",
    "your_model_name",
    "changeme",
    "",
}


def _clean(value: str) -> str:
    value = (value or "").strip()
    # Make Windows-created .env values forgiving: remove one pair of
    # surrounding quotes and ignore common placeholder values.
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"\"", "'"}:
        value = value[1:-1].strip()
    return "" if value.lower() in PLACEHOLDERS else value


def _normalize_provider(value: str) -> str:
    """Map common provider labels to the internal registry names."""
    normalized = _clean(value).lower().replace("_", "").replace("-", "").replace(" ", "")
    aliases = {
        "google": "gemini",
        "googleai": "gemini",
        "geminiai": "gemini",
        "genai": "gemini",
        "gemini": "gemini",
        "openai": "openai",
        "custom": "custom",
        "mock": "mock",
        "offline": "mock",
    }
    return aliases.get(normalized, normalized or "mock")


@dataclass(frozen=True)
class ProviderConfig:
    """Resolved credentials for a single AI provider."""

    name: str
    api_key: str
    api_url: str
    model: str

    @property
    def is_configured(self) -> bool:
        if self.name == "mock":
            return True
        if self.name == "custom":
            return bool(self.api_url)
        return bool(self.api_key)


DEFAULT_URLS = {
    "openai": "https://api.openai.com/v1/chat/completions",
    "gemini": "https://generativelanguage.googleapis.com/v1beta",
    "custom": "",
    "mock": "",
}
DEFAULT_MODELS = {
    "openai": "gpt-4o-mini",
    "gemini": "gemini-2.5-flash",
    "custom": "",
    "mock": "roxy-offline",
}


@dataclass(frozen=True)
class Settings:
    # AI
    provider: str
    generic_key: str
    generic_url: str
    generic_model: str
    temperature: float
    max_tokens: int
    timeout: float
    history_turns: int

    # Server
    host: str
    port: int
    debug: bool
    log_level: str
    allowed_origins: list[str]

    # Limits
    max_message_length: int
    rate_limit_per_minute: int

    # Memory
    memory_enabled: bool
    db_path: Path
    memory_context_limit: int

    # Voice
    wake_word: str
    tts_provider: str
    tts_model: str
    tts_voice: str
    stt_provider: str
    stt_model: str

    frontend_dir: Path = FRONTEND_DIR

    # ── provider resolution ────────────────────────────────────────────
    def provider_config(self, name: str) -> ProviderConfig:
        name = _normalize_provider(name)
        prefix = name.upper()
        key = _clean(_s(f"{prefix}_API_KEY"))
        if name == "gemini" and not key:
            # Google AI Studio also documents GOOGLE_API_KEY as an accepted
            # environment variable name; support it as a convenience.
            key = _clean(_s("GOOGLE_API_KEY"))
        key = key or (self.generic_key if name != "mock" else "")
        url = _clean(_s(f"{prefix}_API_URL")) or self.generic_url or DEFAULT_URLS.get(name, "")
        model = _clean(_s(f"{prefix}_MODEL")) or self.generic_model or DEFAULT_MODELS.get(name, "")
        return ProviderConfig(name=name, api_key=key, api_url=url, model=model)

    def active_provider_config(self) -> ProviderConfig:
        cfg = self.provider_config(self.provider)
        if not cfg.is_configured:
            return self.provider_config("mock")
        return cfg

    def available_providers(self) -> list[str]:
        found = [n for n in ("openai", "gemini", "custom") if self.provider_config(n).is_configured]
        found.append("mock")
        return found


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    db_raw = _s("DB_PATH", "backend/data/roxy.sqlite3")
    db_path = Path(db_raw)
    if not db_path.is_absolute():
        db_path = PROJECT_ROOT / db_path

    return Settings(
        provider=_normalize_provider(_s("AI_PROVIDER", "openai")),
        generic_key=_clean(_s("AI_API_KEY")),
        generic_url=_clean(_s("AI_API_URL")),
        generic_model=_clean(_s("AI_MODEL")),
        temperature=_f("AI_TEMPERATURE", 0.7),
        max_tokens=_i("AI_MAX_TOKENS", 512),
        timeout=_f("AI_TIMEOUT", 30.0),
        history_turns=_i("HISTORY_TURNS", 12),
        host=_s("HOST", "127.0.0.1"),
        port=_i("PORT", 8000),
        debug=_b("DEBUG", False),
        log_level=_s("LOG_LEVEL", "INFO").upper(),
        allowed_origins=_list("ALLOWED_ORIGINS", "*"),
        max_message_length=_i("MAX_MESSAGE_LENGTH", 2000),
        rate_limit_per_minute=_i("RATE_LIMIT_PER_MINUTE", 40),
        memory_enabled=_b("MEMORY_ENABLED", True),
        db_path=db_path,
        memory_context_limit=_i("MEMORY_CONTEXT_LIMIT", 8),
        wake_word=_s("WAKE_WORD", "hey roxy").lower(),
        tts_provider=_s("TTS_PROVIDER", "none").lower(),
        tts_model=_s("TTS_MODEL", "gpt-4o-mini-tts"),
        tts_voice=_s("TTS_VOICE", "nova"),
        stt_provider=_s("STT_PROVIDER", "none").lower(),
        stt_model=_s("STT_MODEL", "whisper-1"),
    )
