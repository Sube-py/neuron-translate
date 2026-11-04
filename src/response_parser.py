"""Normalise the many response shapes returned by Workers AI models."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from jsbridge import to_py
from models import TokenUsage
from provider import Completion


def field_of(value: Any, name: str, default: Any = None) -> Any:
    """Read ``name`` from a dict, a JS object proxy, or return ``default``."""
    if value is None:
        return default
    if isinstance(value, Mapping):
        return value.get(name, default)
    try:
        result = getattr(value, name)
    except Exception:
        return default
    return default if result is None else result


class WorkersAiResponseParser:
    """Extracts text, usage and cache information from an ``AI.run`` result."""

    def parse(self, raw: Any) -> Completion:
        return Completion(
            text=self._text(raw),
            usage=self._usage(raw),
            cached=self._cached(raw),
            reasoning=self._reasoning(raw),
        )

    def _reasoning(self, raw: Any) -> str:
        choices = to_py(field_of(raw, "choices"))
        if isinstance(choices, (list, tuple)) and choices:
            message = field_of(choices[0], "message")
            for name in ("reasoning", "reasoning_content"):
                value = field_of(message, name)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        value = field_of(raw, "reasoning")
        return value.strip() if isinstance(value, str) else ""

    def _text(self, raw: Any) -> str:
        direct = field_of(raw, "response")
        if isinstance(direct, str):
            return direct.strip()

        result = field_of(raw, "result")
        nested = field_of(result, "response") if result is not None else None
        if isinstance(nested, str):
            return nested.strip()

        output_text = field_of(raw, "output_text")
        if isinstance(output_text, str):
            return output_text.strip()

        choices = to_py(field_of(raw, "choices"))
        if isinstance(choices, (list, tuple)) and choices:
            text = self._blocks_text(field_of(choices[0], "message"))
            if text:
                return text

        return self._from_output(to_py(field_of(raw, "output")))

    def _blocks_text(self, message: Any) -> str:
        """Read ``message.content`` whether it is a string or text parts."""
        content = to_py(field_of(message, "content"))
        if isinstance(content, str):
            return content.strip()
        if not isinstance(content, (list, tuple)):
            return ""

        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
                continue
            text = field_of(block, "text")
            if isinstance(text, str):
                parts.append(text)
        return "".join(parts).strip()

    def _from_output(self, output: Any) -> str:
        if isinstance(output, str):
            return output.strip()
        if not isinstance(output, (list, tuple)):
            return ""

        parts: list[str] = []
        for item in output:
            if isinstance(item, str):
                parts.append(item)
                continue
            parts.append(self._blocks_text(item))
        return "".join(parts).strip()

    @staticmethod
    def _usage(raw: Any) -> TokenUsage:
        usage = to_py(field_of(raw, "usage"))
        if not isinstance(usage, Mapping):
            return TokenUsage()
        prompt = usage.get("prompt_tokens", usage.get("input_tokens", 0))
        completion = usage.get("completion_tokens", usage.get("output_tokens", 0))
        return TokenUsage(
            prompt_tokens=int(prompt or 0),
            completion_tokens=int(completion or 0),
        )

    @staticmethod
    def _cached(raw: Any) -> bool:
        for name in ("cached", "cache_hit", "cachedResponse"):
            value = field_of(raw, name)
            if isinstance(value, bool):
                return value
        return False


def shape_of(value: Any) -> str:
    """Compact description of a response shape, safe to log (keys and types only)."""
    if value is None:
        return "None"
    if isinstance(value, Mapping):
        parts = [f"{key}:{type(value[key]).__name__}" for key in list(value)[:8]]
        return "{" + ", ".join(parts) + "}"
    if hasattr(value, "keys"):
        try:
            keys = [str(key) for key in list(value.keys())[:8]]
        except Exception:
            return type(value).__name__
        return "js{" + ", ".join(keys) + "}"
    return type(value).__name__
