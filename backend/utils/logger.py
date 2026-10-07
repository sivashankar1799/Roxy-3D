"""Logging with secret redaction. Verbose tracebacks only in debug mode."""
from __future__ import annotations

import logging
import re
import sys

_SECRET_PATTERNS = [
    re.compile(r"(sk-[A-Za-z0-9_\-]{8,})"),
    re.compile(r"(AIza[0-9A-Za-z_\-]{10,})"),
    re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]{8,}", re.IGNORECASE),
    re.compile(r"(api[_-]?key\"?\s*[:=]\s*\"?)[^\s\",}]+", re.IGNORECASE),
]

_COLORS = {
    "DEBUG": "\033[38;5;245m",
    "INFO": "\033[38;5;51m",
    "WARNING": "\033[38;5;214m",
    "ERROR": "\033[38;5;203m",
    "CRITICAL": "\033[48;5;203m\033[38;5;231m",
}
_RESET = "\033[0m"


def redact(text: str) -> str:
    out = str(text)
    for pattern in _SECRET_PATTERNS:
        out = pattern.sub(lambda m: f"{m.group(1)}***REDACTED***", out)
    return out


class _RedactFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)
        if record.args:
            try:
                record.args = tuple(redact(a) if isinstance(a, str) else a for a in record.args)
            except TypeError:  # dict-style args
                pass
        return True


class _Formatter(logging.Formatter):
    def __init__(self, color: bool) -> None:
        super().__init__("%(asctime)s │ %(levelname)-8s │ %(name)-22s │ %(message)s", "%H:%M:%S")
        self.color = color

    def format(self, record: logging.LogRecord) -> str:
        line = super().format(record)
        if self.color:
            return f"{_COLORS.get(record.levelname, '')}{line}{_RESET}"
        return line


def setup_logging(debug: bool = False, level: str = "INFO") -> None:
    root = logging.getLogger("roxy")
    root.handlers.clear()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_Formatter(color=sys.stdout.isatty()))
    handler.addFilter(_RedactFilter())
    root.addHandler(handler)
    root.setLevel(logging.DEBUG if debug else getattr(logging, level, logging.INFO))
    root.propagate = False


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"roxy.{name}")
