"""Conversation history + long-term fact memory."""
from __future__ import annotations

import re
import time
from typing import Any, Iterable

from ..utils.logger import get_logger
from .database import Database

logger = get_logger("memory")

STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
    "i", "you", "he", "she", "it", "we", "they", "me", "my", "your", "of", "to",
    "in", "on", "for", "with", "that", "this", "do", "does", "did", "what", "how",
    "about", "can", "could", "would", "should", "please", "roxy", "hey",
}

# Explicit user commands
_RE_REMEMBER = re.compile(r"^\s*(?:please\s+)?(?:remember|note|keep in mind|don't forget)\s+(?:that\s+)?(.+)$", re.I)
_RE_FORGET_ALL = re.compile(r"^\s*(?:forget|erase|clear|wipe)\s+(?:everything|all|all of it|your memory|about me)\.?\s*$", re.I)
_RE_FORGET = re.compile(r"^\s*(?:please\s+)?(?:forget|drop)\s+(?:that\s+|about\s+)?(.+)$", re.I)
_RE_RECALL = re.compile(r"^\s*what\s+do\s+you\s+(?:remember|know)\s+about\s+me\??\s*$", re.I)

# Implicit fact patterns → (key, capture-group index)
_FACT_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bmy name is ([A-Za-z][\w '\-]{1,40})", re.I), "name"),
    (re.compile(r"\b(?:i am|i'm) called ([A-Za-z][\w '\-]{1,40})", re.I), "name"),
    (re.compile(r"\bi (?:use|code in|program in|write|work with) ([A-Za-z0-9+#.\- ]{2,40})", re.I), "tools"),
    (re.compile(r"\b(?:i am|i'm) (?:a|an) ([a-z][a-z \-]{2,40})", re.I), "occupation"),
    (re.compile(r"\bi (?:live in|am from|'m from) ([A-Za-z][\w ,'\-]{2,40})", re.I), "location"),
    (re.compile(r"\bi (?:like|love|enjoy|prefer) ([^.,!?;]{2,60})", re.I), "likes"),
    (re.compile(r"\bi (?:hate|dislike|can't stand) ([^.,!?;]{2,60})", re.I), "dislikes"),
    (re.compile(r"\bi(?:'m| am) (?:working on|building) ([^.,!?;]{2,60})", re.I), "current_project"),
    (re.compile(r"\bmy favou?rite ([a-z ]{2,24}) is ([^.,!?;]{2,50})", re.I), "favorite:{0}"),
    (re.compile(r"\bcall me ([A-Za-z][\w '\-]{1,30})", re.I), "preferred_name"),
]

_KEY_HINTS = [
    (re.compile(r"\bname\b", re.I), "name"),
    (re.compile(r"\b(birthday|born)\b", re.I), "birthday"),
    (re.compile(r"\b(live|city|country|from)\b", re.I), "location"),
    (re.compile(r"\b(job|work|career|role)\b", re.I), "occupation"),
    (re.compile(r"\b(python|javascript|rust|go|java|c\+\+|typescript)\b", re.I), "programming_language"),
    (re.compile(r"\b(like|love|favou?rite|prefer)\b", re.I), "likes"),
    (re.compile(r"\b(allerg|diet|vegan|vegetarian)\b", re.I), "dietary"),
    (re.compile(r"\b(goal|want to|planning)\b", re.I), "goals"),
]

MAX_MEMORIES = 200
MAX_VALUE_LEN = 400


def _slug(text: str, limit: int = 40) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return slug[:limit] or "note"


def _tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]{3,}", text.lower()) if w not in STOPWORDS}


class MemoryManager:
    def __init__(self, db: Database, *, enabled: bool = True, context_limit: int = 8) -> None:
        self.db = db
        self.enabled = enabled
        self.context_limit = context_limit

    # ── conversation history ───────────────────────────────────────────
    async def add_message(self, session_id: str, role: str, content: str) -> None:
        if role not in ("user", "assistant") or not content:
            return
        try:
            await self.db.execute(
                "INSERT INTO conversations (session_id, role, content, created_at) VALUES (?,?,?,?)",
                (session_id, role, content[:8000], time.time()),
            )
        except Exception as exc:
            logger.warning("Could not persist message: %s", exc)

    async def get_recent_messages(self, session_id: str, turns: int = 12) -> list[dict[str, Any]]:
        try:
            rows = await self.db.fetch_all(
                "SELECT role, content FROM conversations WHERE session_id = ? ORDER BY id DESC LIMIT ?",
                (session_id, max(2, turns * 2)),
            )
        except Exception as exc:
            logger.warning("History read failed: %s", exc)
            return []
        return list(reversed(rows))

    async def get_history(self, session_id: str, limit: int = 100) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT role, content, created_at FROM conversations WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (session_id, limit),
        )
        return list(reversed(rows))

    async def clear_history(self, session_id: str) -> None:
        await self.db.execute("DELETE FROM conversations WHERE session_id = ?", (session_id,))

    # ── long-term facts ────────────────────────────────────────────────
    async def remember(self, key: str, value: str, source: str = "auto") -> None:
        if not self.enabled:
            return
        key = _slug(key)
        value = value.strip()[:MAX_VALUE_LEN]
        if not key or not value:
            return
        now = time.time()
        try:
            await self.db.execute(
                """INSERT INTO memories (key, value, source, created_at, updated_at)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value,
                                                  source=excluded.source,
                                                  updated_at=excluded.updated_at""",
                (key, value, source, now, now),
            )
            await self.db.execute(
                """DELETE FROM memories WHERE key IN (
                       SELECT key FROM memories ORDER BY updated_at DESC LIMIT -1 OFFSET ?)""",
                (MAX_MEMORIES,),
            )
            logger.debug("Remembered %s=%s (%s)", key, value[:40], source)
        except Exception as exc:
            logger.warning("Memory write failed: %s", exc)

    async def forget(self, query: str) -> bool:
        query = query.strip().lower().rstrip(".!?")
        if not query:
            return False
        removed = await self.db.execute("DELETE FROM memories WHERE key = ?", (_slug(query),))
        if removed:
            return True
        like = f"%{query}%"
        removed = await self.db.execute(
            "DELETE FROM memories WHERE LOWER(value) LIKE ? OR key LIKE ?", (like, f"%{_slug(query)}%")
        )
        return bool(removed)

    async def delete_key(self, key: str) -> bool:
        return bool(await self.db.execute("DELETE FROM memories WHERE key = ?", (_slug(key),)))

    async def clear_memories(self) -> None:
        await self.db.execute("DELETE FROM memories", ())

    async def get_all(self) -> list[dict[str, Any]]:
        try:
            return await self.db.fetch_all(
                "SELECT key, value, source, updated_at FROM memories ORDER BY updated_at DESC", ()
            )
        except Exception as exc:
            logger.warning("Memory read failed: %s", exc)
            return []

    async def build_context(self, user_text: str) -> str:
        """Pick the memories most relevant to the incoming message."""
        items = await self.get_all()
        if not items:
            return ""
        query = _tokens(user_text)
        scored: list[tuple[float, dict[str, Any]]] = []
        for index, item in enumerate(items):
            overlap = len(query & _tokens(f"{item['key']} {item['value']}"))
            recency = 1.0 - (index / max(1, len(items)))
            pinned = 1.5 if item["key"] in ("name", "preferred_name") else 0.0
            scored.append((overlap * 2.0 + recency + pinned, item))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        chosen = [item for _, item in scored[: self.context_limit]]
        return "\n".join(f"- {item['key'].replace('_', ' ')}: {item['value']}" for item in chosen)

    # ── parsing helpers ────────────────────────────────────────────────
    def parse_command(self, text: str) -> tuple[str, str] | None:
        if not self.enabled:
            return None
        stripped = text.strip()
        if _RE_RECALL.match(stripped):
            return ("recall", "")
        if _RE_FORGET_ALL.match(stripped):
            return ("forget_all", "")
        match = _RE_REMEMBER.match(stripped)
        if match:
            return ("remember", match.group(1).strip().rstrip("."))
        match = _RE_FORGET.match(stripped)
        if match:
            return ("forget", match.group(1).strip().rstrip("."))
        return None

    def derive_key(self, value: str) -> tuple[str, str]:
        for pattern, key in _KEY_HINTS:
            if pattern.search(value):
                return key, value
        words = [w for w in re.findall(r"[A-Za-z0-9]+", value) if w.lower() not in STOPWORDS]
        return _slug("_".join(words[:3]) or "note"), value

    def extract_facts(self, text: str) -> Iterable[tuple[str, str]]:
        """Lightweight heuristics so memory works even with a dumb model."""
        if not self.enabled:
            return []
        found: list[tuple[str, str]] = []
        for pattern, key_template in _FACT_PATTERNS:
            match = pattern.search(text)
            if not match:
                continue
            groups = match.groups()
            if "{0}" in key_template and len(groups) >= 2:
                key = _slug(key_template.format(groups[0]))
                value = groups[1].strip()
            else:
                key = key_template
                value = groups[-1].strip()
            value = re.sub(r"\s+", " ", value).strip(" .,!?")
            if 1 < len(value) <= MAX_VALUE_LEN:
                found.append((key, value))
        return found
