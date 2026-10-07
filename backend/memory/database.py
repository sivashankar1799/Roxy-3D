"""Thin async wrapper over stdlib sqlite3 (all calls run in a worker thread)."""
from __future__ import annotations

import asyncio
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable

from ..utils.logger import get_logger

logger = get_logger("database")

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    role       TEXT    NOT NULL CHECK (role IN ('user','assistant')),
    content    TEXT    NOT NULL,
    created_at REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id, id);

CREATE TABLE IF NOT EXISTS memories (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'auto',
    hits       INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
"""


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.Lock()

    # ── lifecycle ──────────────────────────────────────────────────────
    async def connect(self) -> None:
        await asyncio.to_thread(self._connect_sync)

    def _connect_sync(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()
        logger.info("SQLite ready at %s", self.path)

    async def close(self) -> None:
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.commit()
                self._conn.close()
                self._conn = None

    # ── queries ────────────────────────────────────────────────────────
    def _require(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError("Database is not connected")
        return self._conn

    async def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        return await asyncio.to_thread(self._execute_sync, sql, tuple(params))

    def _execute_sync(self, sql: str, params: tuple[Any, ...]) -> int:
        with self._lock:
            conn = self._require()
            cursor = conn.execute(sql, params)
            conn.commit()
            return cursor.rowcount

    async def fetch_all(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._fetch_all_sync, sql, tuple(params))

    def _fetch_all_sync(self, sql: str, params: tuple[Any, ...]) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._require().execute(sql, params).fetchall()
            return [dict(row) for row in rows]

    async def fetch_one(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        rows = await self.fetch_all(sql, params)
        return rows[0] if rows else None
