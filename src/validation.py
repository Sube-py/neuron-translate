"""Validation of the JSON payload accepted by ``POST /translate``."""

from __future__ import annotations

from collections.abc import Mapping

from errors import ValidationError
from models import TranslationRequest

MAX_TEXT_CHARS_HARD_LIMIT = 200_000
MAX_LANG_CODE_CHARS = 20
MAX_TONE_CHARS = 120
MAX_GLOSSARY_ENTRIES = 50
MAX_GLOSSARY_TERM_CHARS = 200
DEFAULT_TARGET_LANG = "en"


class TranslationRequestParser:
    """Turns untrusted JSON into a :class:`TranslationRequest`."""

    def __init__(self, max_text_chars: int = 20_000) -> None:
        self._max_text_chars = min(max_text_chars, MAX_TEXT_CHARS_HARD_LIMIT)

    def parse(self, payload: Mapping[str, object] | None) -> TranslationRequest:
        if not isinstance(payload, Mapping):
            raise ValidationError("Request body must be a JSON object.")

        text = self._text(payload)
        return TranslationRequest(
            text=text,
            target_lang=self._lang(payload, "target_lang", DEFAULT_TARGET_LANG),
            source_lang=self._lang(payload, "source_lang", "auto"),
            tone=self._tone(payload),
            glossary=self._glossary(payload),
            preserve_formatting=self._bool(payload, "preserve_formatting", default=True),
            model=self._model(payload),
        )

    def _model(self, payload: Mapping[str, object]) -> str | None:
        raw = payload.get("model")
        if raw is None:
            return None
        if not isinstance(raw, str):
            raise ValidationError("Field 'model' must be a string.", field="model")
        candidate = raw.strip()
        if not candidate:
            return None
        if len(candidate) > 120:
            raise ValidationError("Field 'model' is too long.", field="model")
        return candidate

    def _text(self, payload: Mapping[str, object]) -> str:
        raw = payload.get("text")
        if not isinstance(raw, str) or not raw.strip():
            raise ValidationError(
                "Field 'text' is required and must be a non-empty string.",
                field="text",
            )
        if len(raw) > self._max_text_chars:
            raise ValidationError(
                f"Field 'text' exceeds the {self._max_text_chars} character limit.",
                field="text",
            )
        return raw

    def _lang(self, payload: Mapping[str, object], field_name: str, default: str) -> str:
        raw = payload.get(field_name, default)
        if raw is None:
            return default
        if not isinstance(raw, str):
            raise ValidationError(f"Field '{field_name}' must be a string.", field=field_name)
        code = raw.strip() or default
        if len(code) > MAX_LANG_CODE_CHARS:
            raise ValidationError(
                f"Field '{field_name}' must be at most {MAX_LANG_CODE_CHARS} characters.",
                field=field_name,
            )
        return code

    def _tone(self, payload: Mapping[str, object]) -> str | None:
        raw = payload.get("tone")
        if raw is None:
            return None
        if not isinstance(raw, str):
            raise ValidationError("Field 'tone' must be a string.", field="tone")
        tone = raw.strip()
        if not tone:
            return None
        if len(tone) > MAX_TONE_CHARS:
            raise ValidationError(
                f"Field 'tone' must be at most {MAX_TONE_CHARS} characters.",
                field="tone",
            )
        return tone

    def _glossary(self, payload: Mapping[str, object]) -> dict[str, str]:
        raw = payload.get("glossary")
        if raw is None:
            return {}
        if not isinstance(raw, Mapping):
            raise ValidationError(
                "Field 'glossary' must be an object of source term to translation.",
                field="glossary",
            )
        if len(raw) > MAX_GLOSSARY_ENTRIES:
            raise ValidationError(
                f"Field 'glossary' supports at most {MAX_GLOSSARY_ENTRIES} entries.",
                field="glossary",
            )

        glossary: dict[str, str] = {}
        for term, translated in raw.items():
            if not isinstance(term, str) or not isinstance(translated, str):
                raise ValidationError("Glossary keys and values must be strings.", field="glossary")
            clean_term = term.strip()
            clean_translated = translated.strip()
            if not clean_term or not clean_translated:
                raise ValidationError("Glossary entries cannot be empty.", field="glossary")
            if len(clean_term) > MAX_GLOSSARY_TERM_CHARS:
                raise ValidationError(
                    f"Glossary terms must be at most {MAX_GLOSSARY_TERM_CHARS} characters.",
                    field="glossary",
                )
            glossary[clean_term] = clean_translated
        return glossary

    def _bool(self, payload: Mapping[str, object], field_name: str, *, default: bool) -> bool:
        raw = payload.get(field_name)
        if raw is None:
            return default
        if not isinstance(raw, bool):
            raise ValidationError(f"Field '{field_name}' must be a boolean.", field=field_name)
        return raw
