"""Conversation orchestration: memory, prompting, provider calls, parsing."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from ..config import Settings
from ..memory.memory import MemoryManager
from ..utils.logger import get_logger
from .prompts import (
    MEMORY_ACK,
    MEMORY_EMPTY,
    MEMORY_FORGET_ACK,
    MEMORY_FORGET_MISS,
    build_system_prompt,
)
from .providers import AIProvider, AIProviderError, ChatMessage, create_provider
from .response_parser import ParsedResponse, parse_response, sanitize_text

logger = get_logger("assistant")


@dataclass
class AssistantReply:
    text: str
    emotion: str = "neutral"
    animation: str = "talking"
    ok: bool = True
    error_code: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    def to_message(self) -> dict[str, Any]:
        return {
            "type": "assistant_response",
            "message": self.text,
            "emotion": self.emotion,
            "animation": self.animation,
            "ok": self.ok,
            "error_code": self.error_code,
            "meta": self.meta,
            "timestamp": time.time(),
        }


class RoxyAssistant:
    def __init__(self, settings: Settings, memory: MemoryManager) -> None:
        self.settings = settings
        self.memory = memory
        self._provider_name = settings.active_provider_config().name
        self._provider: AIProvider = create_provider(settings.active_provider_config(), settings)
        self._lock = asyncio.Lock()
        logger.info("Assistant ready with provider=%s model=%s", self._provider.name, self._provider.config.model)

    # ── provider management ────────────────────────────────────────────
    @property
    def provider(self) -> AIProvider:
        return self._provider

    async def set_provider(self, name: str) -> bool:
        name = (name or "").lower()
        if name not in self.settings.available_providers():
            return False
        async with self._lock:
            old = self._provider
            self._provider = create_provider(self.settings.provider_config(name), self.settings)
            self._provider_name = self._provider.name
            await old.aclose()
        logger.info("Provider switched to %s", self._provider.name)
        return True

    async def aclose(self) -> None:
        await self._provider.aclose()

    def status(self) -> dict[str, Any]:
        cfg = self._provider.config
        return {
            "provider": self._provider.name,
            "model": cfg.model or "(default)",
            "configured": cfg.is_configured,
            "offline_mode": self._provider.name == "mock",
            "available_providers": self.settings.available_providers(),
            "memory_enabled": self.settings.memory_enabled,
        }

    # ── main entry point ───────────────────────────────────────────────
    async def handle_message(self, session_id: str, raw_text: str) -> AssistantReply:
        text = sanitize_text(raw_text)[: self.settings.max_message_length].strip()
        if not text:
            return AssistantReply("I didn't catch anything there.", "confused", "thinking")

        await self.memory.add_message(session_id, "user", text)

        # 1. Deterministic memory commands — no API call, always reliable.
        command = self.memory.parse_command(text)
        if command is not None:
            reply = await self._handle_memory_command(session_id, command)
            await self.memory.add_message(session_id, "assistant", reply.text)
            return reply

        # 2. Build context and call the provider.
        memory_context = await self.memory.build_context(text) if self.settings.memory_enabled else ""
        system_prompt = build_system_prompt(memory_context)
        history = await self.memory.get_recent_messages(session_id, self.settings.history_turns)
        messages = [ChatMessage(role=item["role"], content=item["content"]) for item in history]
        if not messages or messages[-1].content != text:
            messages.append(ChatMessage(role="user", content=text))

        started = time.perf_counter()
        try:
            raw = await asyncio.wait_for(
                self._provider.complete(system_prompt, messages),
                timeout=self.settings.timeout + 5,
            )
        except asyncio.TimeoutError:
            logger.warning("Provider %s timed out", self._provider.name)
            return AssistantReply(
                "That took longer than I'd like. Could you try once more?",
                "confused", "thinking", ok=False, error_code="timeout",
            )
        except AIProviderError as exc:
            logger.error("Provider error [%s]: %s", exc.code, exc.detail)
            return AssistantReply(exc.user_message, "sad", "idle", ok=False, error_code=exc.code)
        except Exception as exc:  # never crash the socket
            logger.exception("Unexpected provider failure: %s", exc)
            return AssistantReply(
                "Something went wrong on my side. I'm still here though.",
                "confused", "idle", ok=False, error_code="internal",
            )

        elapsed = (time.perf_counter() - started) * 1000
        parsed: ParsedResponse = parse_response(raw)

        await self.memory.add_message(session_id, "assistant", parsed.text)
        await self._store_implicit_memories(text, parsed)

        logger.debug("Reply in %.0f ms (structured=%s)", elapsed, parsed.structured)
        return AssistantReply(
            text=parsed.text,
            emotion=parsed.emotion,
            animation=parsed.animation,
            meta={
                "latency_ms": round(elapsed),
                "structured": parsed.structured,
                "provider": self._provider.name,
            },
        )

    # ── helpers ────────────────────────────────────────────────────────
    async def _handle_memory_command(self, session_id: str, command: tuple[str, str]) -> AssistantReply:
        action, payload = command

        if action == "remember":
            key, value = self.memory.derive_key(payload)
            await self.memory.remember(key, value, source="explicit")
            return AssistantReply(f"{MEMORY_ACK} ({value})", "happy", "happy")

        if action == "forget":
            removed = await self.memory.forget(payload)
            if removed:
                return AssistantReply(MEMORY_FORGET_ACK, "neutral", "talking")
            return AssistantReply(MEMORY_FORGET_MISS, "confused", "thinking")

        if action == "forget_all":
            await self.memory.clear_memories()
            return AssistantReply("My memory of you is clear now.", "neutral", "talking")

        if action == "recall":
            items = await self.memory.get_all()
            if not items:
                return AssistantReply(MEMORY_EMPTY, "neutral", "talking")
            listed = "; ".join(f"{item['key'].replace('_', ' ')}: {item['value']}" for item in items[:12])
            return AssistantReply(f"Here's what I've kept: {listed}.", "happy", "explaining")

        return AssistantReply("I'm not sure what to do with that.", "confused", "thinking")

    async def _store_implicit_memories(self, user_text: str, parsed: ParsedResponse) -> None:
        if not self.settings.memory_enabled:
            return
        if parsed.memory:
            await self.memory.remember(parsed.memory["key"], parsed.memory["value"], source="model")
        for key, value in self.memory.extract_facts(user_text):
            await self.memory.remember(key, value, source="auto")
