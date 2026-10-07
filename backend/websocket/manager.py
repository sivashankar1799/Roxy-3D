"""WebSocket connection registry, validation models and rate limiting."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import WebSocket
from pydantic import BaseModel, Field, field_validator

from ..utils.logger import get_logger

logger = get_logger("ws")

MAX_FRAME_BYTES = 64 * 1024

ClientMessageType = Literal[
    "hello", "ping", "user_message", "get_memories", "delete_memory",
    "clear_memories", "get_history", "clear_history", "set_provider", "tts",
]


class ClientMessage(BaseModel):
    """Every inbound frame is validated against this model before dispatch."""

    type: ClientMessageType
    message: str = Field(default="", max_length=8000)
    session_id: str = Field(default="", max_length=64)
    key: str = Field(default="", max_length=128)
    provider: str = Field(default="", max_length=32)
    text: str = Field(default="", max_length=8000)
    voice: str = Field(default="", max_length=64)
    speed: float = Field(default=1.0, ge=0.25, le=4.0)

    @field_validator("session_id")
    @classmethod
    def _safe_session(cls, value: str) -> str:
        return "".join(ch for ch in value if ch.isalnum() or ch in "-_")[:64]

    @field_validator("provider")
    @classmethod
    def _safe_provider(cls, value: str) -> str:
        return "".join(ch for ch in value.lower() if ch.isalnum() or ch == "_")[:32]


class RateLimiter:
    """Token bucket, one per connection."""

    def __init__(self, per_minute: int) -> None:
        self.capacity = max(1, per_minute)
        self.tokens = float(self.capacity)
        self.rate = self.capacity / 60.0
        self.updated = time.monotonic()

    def allow(self) -> bool:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return True
        return False


@dataclass
class Connection:
    id: str
    socket: WebSocket
    session_id: str
    limiter: RateLimiter
    connected_at: float = field(default_factory=time.time)
    busy: bool = False


class ConnectionManager:
    def __init__(self, rate_limit_per_minute: int = 40) -> None:
        self._connections: dict[str, Connection] = {}
        self._rate_limit = rate_limit_per_minute

    @property
    def count(self) -> int:
        return len(self._connections)

    async def connect(self, socket: WebSocket) -> Connection:
        await socket.accept()
        client_id = uuid.uuid4().hex[:12]
        connection = Connection(
            id=client_id,
            socket=socket,
            session_id=client_id,
            limiter=RateLimiter(self._rate_limit),
        )
        self._connections[client_id] = connection
        logger.info("Client %s connected (%d active)", client_id, self.count)
        return connection

    def disconnect(self, connection: Connection) -> None:
        self._connections.pop(connection.id, None)
        logger.info("Client %s disconnected (%d active)", connection.id, self.count)

    async def send(self, connection: Connection, payload: dict[str, Any]) -> bool:
        try:
            await connection.socket.send_json(payload)
            return True
        except Exception as exc:  # socket closed mid-write
            logger.debug("Send to %s failed: %s", connection.id, exc)
            return False

    async def send_status(self, connection: Connection, status: str) -> None:
        await self.send(connection, {"type": "status", "status": status, "timestamp": time.time()})

    async def send_error(self, connection: Connection, code: str, message: str) -> None:
        await self.send(connection, {"type": "error", "code": code, "message": message, "timestamp": time.time()})

    async def send_character(self, connection: Connection, animation: str, emotion: str | None = None) -> None:
        payload: dict[str, Any] = {"type": "character", "animation": animation}
        if emotion:
            payload["emotion"] = emotion
        await self.send(connection, payload)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        for connection in list(self._connections.values()):
            await self.send(connection, payload)

    async def shutdown(self) -> None:
        for connection in list(self._connections.values()):
            try:
                await connection.socket.close(code=1001)
            except Exception:
                pass
        self._connections.clear()
