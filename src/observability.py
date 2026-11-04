"""Structured JSON logging for Workers logs and trace correlation."""

from __future__ import annotations

import json
import time
from typing import Any

from jsbridge import to_js


class JsonLogger:
    """Emits one JSON object per log line so ``wrangler tail`` stays parseable."""

    def __init__(self, service: str = "trans", enabled: bool = True) -> None:
        self._service = service
        self._enabled = enabled

    def info(self, event: str, **fields: Any) -> None:
        self._emit("info", event, fields)

    def warning(self, event: str, **fields: Any) -> None:
        self._emit("warning", event, fields)

    def error(self, event: str, **fields: Any) -> None:
        self._emit("error", event, fields)

    def _emit(self, level: str, event: str, fields: dict[str, Any]) -> None:
        if not self._enabled:
            return
        record = {
            "service": self._service,
            "level": level,
            "event": event,
            "ts": round(time.time(), 3),
            **fields,
        }
        try:
            print(json.dumps(record, ensure_ascii=False, default=str))
        except Exception:
            print(json.dumps({"service": self._service, "event": event}))


def console_log(value: Any) -> None:
    """Write a value to the Workers console when running in the runtime."""
    try:
        from js import console
    except ImportError:
        return
    console.log(to_js(value))
