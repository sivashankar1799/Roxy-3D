"""ROXY FastAPI application: REST health/config, WebSocket bridge, static frontend."""
from __future__ import annotations

import json
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .ai.assistant import RoxyAssistant
from .config import get_settings
from .memory.database import Database
from .memory.memory import MemoryManager
from .utils.logger import get_logger, setup_logging
from .voice.speech_to_text import create_stt_engine
from .voice.text_to_speech import create_tts_engine
from .voice.wake_word import WakeWordConfig
from .websocket.manager import MAX_FRAME_BYTES, ClientMessage, ConnectionManager

settings = get_settings()
setup_logging(settings.debug, settings.log_level)
logger = get_logger("main")

state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("ROXY starting…")
    database = Database(settings.db_path)
    await database.connect()

    memory = MemoryManager(database, enabled=settings.memory_enabled, context_limit=settings.memory_context_limit)
    state["db"] = database
    state["memory"] = memory
    state["assistant"] = RoxyAssistant(settings, memory)
    state["tts"] = create_tts_engine(settings)
    state["stt"] = create_stt_engine(settings)
    state["manager"] = ConnectionManager(settings.rate_limit_per_minute)
    state["wake_word"] = WakeWordConfig(phrase=settings.wake_word)
    state["started_at"] = time.time()

    if state["assistant"].provider.name == "mock":
        logger.warning("No AI credentials detected — running in OFFLINE DEMO mode.")

    try:
        yield
    finally:
        logger.info("ROXY shutting down…")
        await state["manager"].shutdown()
        await state["assistant"].aclose()
        await state["tts"].aclose()
        await state["stt"].aclose()
        await database.close()


app = FastAPI(title="ROXY", version="1.0.0", lifespan=lifespan, docs_url="/api/docs" if settings.debug else None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# ── REST ────────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health() -> JSONResponse:
    assistant: RoxyAssistant = state["assistant"]
    return JSONResponse(
        {
            "status": "ok",
            "uptime_s": round(time.time() - state.get("started_at", time.time())),
            "connections": state["manager"].count,
            "ai": assistant.status(),
            "voice": {
                "server_tts": state["tts"].available,
                "server_stt": state["stt"].available,
            },
        }
    )


@app.get("/api/config")
async def public_config() -> JSONResponse:
    """Public, secret-free configuration for the browser."""
    assistant: RoxyAssistant = state["assistant"]
    status = assistant.status()
    return JSONResponse(
        {
            "wake_word": state["wake_word"].to_client(),
            "max_message_length": settings.max_message_length,
            "memory_enabled": settings.memory_enabled,
            "providers": status["available_providers"],
            "active_provider": status["provider"],
            "model": status["model"],
            "offline_mode": status["offline_mode"],
            "server_tts": state["tts"].available,
            "server_stt": state["stt"].available,
            "debug": settings.debug,
        }
    )


@app.get("/api/memories")
async def list_memories() -> JSONResponse:
    return JSONResponse({"items": await state["memory"].get_all()})


@app.delete("/api/memories")
async def clear_memories() -> JSONResponse:
    await state["memory"].clear_memories()
    return JSONResponse({"ok": True})


# ── WebSocket ───────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(socket: WebSocket) -> None:
    manager: ConnectionManager = state["manager"]
    assistant: RoxyAssistant = state["assistant"]
    memory: MemoryManager = state["memory"]
    connection = await manager.connect(socket)

    await manager.send(
        connection,
        {
            "type": "welcome",
            "client_id": connection.id,
            "wake_word": state["wake_word"].to_client(),
            "ai": assistant.status(),
            "server_tts": state["tts"].available,
            "max_message_length": settings.max_message_length,
            "timestamp": time.time(),
        },
    )

    try:
        while True:
            raw = await socket.receive_text()

            if len(raw) > MAX_FRAME_BYTES:
                await manager.send_error(connection, "too_large", "That message is too large for me to accept.")
                continue

            try:
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise ValueError("frame must be a JSON object")
                message = ClientMessage.model_validate(payload)
            except (json.JSONDecodeError, ValueError, ValidationError) as exc:
                logger.debug("Rejected malformed frame: %s", exc)
                await manager.send_error(connection, "bad_request", "I couldn't read that request.")
                continue

            await _dispatch(connection, message, manager, assistant, memory)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("WebSocket loop error: %s", exc)
    finally:
        manager.disconnect(connection)


async def _dispatch(connection, message: ClientMessage, manager, assistant: RoxyAssistant, memory: MemoryManager) -> None:
    kind = message.type

    if kind == "ping":
        await manager.send(connection, {"type": "pong", "timestamp": time.time()})
        return

    if kind == "hello":
        if message.session_id:
            connection.session_id = message.session_id
        await manager.send(connection, {"type": "session", "session_id": connection.session_id})
        return

    if not connection.limiter.allow():
        await manager.send_error(connection, "rate_limited", "You're going a little fast for me — one moment.")
        return

    if kind == "user_message":
        text = message.message.strip()
        if not text:
            await manager.send_error(connection, "empty", "There was nothing in that message.")
            return
        if len(text) > settings.max_message_length:
            await manager.send_error(
                connection, "too_long",
                f"Please keep messages under {settings.max_message_length} characters.",
            )
            return
        if connection.busy:
            await manager.send_error(connection, "busy", "Let me finish the last thought first.")
            return

        connection.busy = True
        try:
            await manager.send_status(connection, "processing")
            await manager.send_character(connection, "thinking")
            reply = await assistant.handle_message(connection.session_id, text)
            await manager.send(connection, reply.to_message())

            if reply.ok and state["tts"].available:
                await manager.send_status(connection, "synthesizing")
                audio = await state["tts"].synthesize(reply.text, voice=message.voice or None, speed=message.speed)
                if audio:
                    await manager.send(
                        connection,
                        {"type": "audio", "format": audio.mime, "data": audio.to_base64(), "text": reply.text},
                    )
            await manager.send_status(connection, "idle")
        finally:
            connection.busy = False
        return

    if kind == "tts":
        if not state["tts"].available:
            await manager.send(connection, {"type": "audio_unavailable"})
            return
        audio = await state["tts"].synthesize(message.text, voice=message.voice or None, speed=message.speed)
        if audio:
            await manager.send(
                connection, {"type": "audio", "format": audio.mime, "data": audio.to_base64(), "text": message.text}
            )
        else:
            await manager.send(connection, {"type": "audio_unavailable"})
        return

    if kind == "get_memories":
        await manager.send(connection, {"type": "memories", "items": await memory.get_all()})
        return

    if kind == "delete_memory":
        ok = await memory.delete_key(message.key)
        await manager.send(connection, {"type": "memories", "items": await memory.get_all(), "deleted": ok})
        return

    if kind == "clear_memories":
        await memory.clear_memories()
        await manager.send(connection, {"type": "memories", "items": []})
        return

    if kind == "get_history":
        items = await memory.get_history(connection.session_id)
        await manager.send(connection, {"type": "history", "items": items})
        return

    if kind == "clear_history":
        await memory.clear_history(connection.session_id)
        await manager.send(connection, {"type": "history", "items": []})
        return

    if kind == "set_provider":
        ok = await assistant.set_provider(message.provider)
        await manager.send(connection, {"type": "provider", "ok": ok, "ai": assistant.status()})
        if not ok:
            await manager.send_error(connection, "provider", "That provider isn't configured on the server.")
        return


# ── Static frontend (mounted last so /api and /ws win) ──────────────────────
FRONTEND = settings.frontend_dir
if FRONTEND.is_dir():
    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon():
        ico, svg = FRONTEND / "favicon.ico", FRONTEND / "favicon.svg"
        if ico.is_file():
            return FileResponse(ico)
        if svg.is_file():
            return FileResponse(svg, media_type="image/svg+xml")
        return JSONResponse(status_code=404, content={"detail": "no favicon"})

    app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
else:  # pragma: no cover
    logger.error("Frontend directory missing: %s", FRONTEND)
