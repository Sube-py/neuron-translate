"""Validation for OpenAI-compatible chat completion requests."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from chat_models import SUPPORTED_ROLES, ChatMessage, ChatRequest
from errors import ValidationError
from jsbridge import to_py

MAX_MESSAGES = 64
MAX_MESSAGE_CHARS = 100_000
MAX_TEXT_CHARS_HARD_LIMIT = 200_000
MAX_TONE_CHARS = 120
MAX_GLOSSARY_ENTRIES = 50
DEFAULT_TEMPERATURE_LIMIT = 2.0
MAX_COMPLETION_TOKENS = 8192


class ChatRequestParser:
    """Accepts the OpenAI body shape and ignores unknown fields."""

    def __init__(self, max_text_chars: int = 20_000) -> None:
        self._max_text_chars = min(max_text_chars, MAX_TEXT_CHARS_HARD_LIMIT)

    def parse(self, payload: Mapping[str, Any] | None) -> ChatRequest:
        if not isinstance(payload, Mapping):
            raise ValidationError("Request body must be a JSON object.")

        messages = self._messages(payload)

        return ChatRequest(
            messages=messages,
            model=self._model(payload),
            stream=self._bool(payload, "stream", default=False),
            include_usage=self._include_usage(payload),
            temperature=self._temperature(payload),
            max_tokens=self._max_tokens(payload),
            tone=self._tone(payload),
            target_lang=self._target_lang(payload),
            glossary=self._glossary(payload),
        )

    def _messages(self, payload: Mapping[str, Any]) -> tuple[ChatMessage, ...]:
        raw = to_py(payload.get("messages"))
        if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)) or not raw:
            raise ValidationError(
                "Field 'messages' is required and must be a non-empty array.",
                field="messages",
            )
        if len(raw) > MAX_MESSAGES:
            raise ValidationError(
                f"Field 'messages' supports at most {MAX_MESSAGES} entries.",
                field="messages",
            )

        messages: list[ChatMessage] = []
        total_chars = 0
        for index, item in enumerate(raw):
            message = self._message(item, index)
            total_chars += len(message.content)
            messages.append(message)

        if total_chars > self._max_text_chars:
            raise ValidationError(
                f"Conversation exceeds the {self._max_text_chars} character limit.",
                field="messages",
            )
        return tuple(messages)

    def _message(self, item: Any, index: int) -> ChatMessage:
        if not isinstance(item, Mapping):
            raise ValidationError(
                f"messages[{index}] must be an object.", field=f"messages[{index}]"
            )

        role = item.get("role")
        if not isinstance(role, str) or role not in SUPPORTED_ROLES:
            raise ValidationError(
                f"messages[{index}].role must be one of {sorted(SUPPORTED_ROLES)}.",
                field=f"messages[{index}].role",
            )

        content = self._content(item.get("content"), index)
        if len(content) > MAX_MESSAGE_CHARS:
            raise ValidationError(
                f"messages[{index}].content is too long.", field=f"messages[{index}].content"
            )
        return ChatMessage(role=role, content=content)

    @staticmethod
    def _content(value: Any, index: int) -> str:
        raw = to_py(value)
        if isinstance(raw, str):
            return raw
        if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)):
            parts: list[str] = []
            for part in raw:
                if isinstance(part, Mapping):
                    text = part.get("text")
                    if isinstance(text, str):
                        parts.append(text)
            return "".join(parts)
        raise ValidationError(
            f"messages[{index}].content must be a string or text parts array.",
            field=f"messages[{index}].content",
        )

    @staticmethod
    def _model(payload: Mapping[str, Any]) -> str | None:
        raw = payload.get("model")
        if not isinstance(raw, str):
            return None
        return raw.strip()[:120] or None

    @staticmethod
    def _bool(payload: Mapping[str, Any], name: str, *, default: bool) -> bool:
        raw = payload.get(name)
        return raw if isinstance(raw, bool) else default

    @staticmethod
    def _include_usage(payload: Mapping[str, Any]) -> bool:
        options = payload.get("stream_options")
        if isinstance(options, Mapping):
            include = options.get("include_usage")
            if isinstance(include, bool):
                return include
        return False

    @staticmethod
    def _temperature(payload: Mapping[str, Any]) -> float | None:
        raw = payload.get("temperature")
        if not isinstance(raw, (int, float)) or isinstance(raw, bool):
            return None
        return min(max(float(raw), 0.0), DEFAULT_TEMPERATURE_LIMIT)

    def _max_tokens(self, payload: Mapping[str, Any]) -> int | None:
        for name in ("max_tokens", "max_completion_tokens"):
            raw = payload.get(name)
            if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0:
                return min(raw, MAX_COMPLETION_TOKENS)
        return None

    @staticmethod
    def _tone(payload: Mapping[str, Any]) -> str | None:
        raw = payload.get("tone")
        if not isinstance(raw, str):
            return None
        tone = raw.strip()
        return tone[:MAX_TONE_CHARS] or None

    @staticmethod
    def _target_lang(payload: Mapping[str, Any]) -> str | None:
        raw = payload.get("target_lang")
        if not isinstance(raw, str):
            return None
        return raw.strip()[:20] or None

    @staticmethod
    def _glossary(payload: Mapping[str, Any]) -> dict[str, str]:
        raw = payload.get("glossary")
        if not isinstance(raw, Mapping):
            return {}
        glossary: dict[str, str] = {}
        for term, translated in list(raw.items())[:MAX_GLOSSARY_ENTRIES]:
            if isinstance(term, str) and isinstance(translated, str):
                clean_term, clean_translated = term.strip(), translated.strip()
                if clean_term and clean_translated:
                    glossary[clean_term] = clean_translated
        return glossary
