from __future__ import annotations

import pytest

from errors import ValidationError
from validation import TranslationRequestParser


def test_parses_minimal_payload() -> None:
    request = TranslationRequestParser().parse({"text": "hi"})

    assert request.text == "hi"
    assert request.target_lang == "en"
    assert request.source_lang == "auto"
    assert request.tone is None
    assert request.glossary == {}
    assert request.preserve_formatting is True


def test_parses_full_payload() -> None:
    request = TranslationRequestParser().parse(
        {
            "text": "  hello  ",
            "target_lang": "zh-CN",
            "source_lang": "en",
            "tone": "formal",
            "glossary": {" workers ": " 无服务器 "},
            "preserve_formatting": False,
        }
    )

    assert request.text == "  hello  "
    assert request.target_lang == "zh-CN"
    assert request.tone == "formal"
    assert request.glossary == {"workers": "无服务器"}
    assert request.preserve_formatting is False


@pytest.mark.parametrize("payload", [None, [], "text", 42])
def test_rejects_non_object_payload(payload: object) -> None:
    with pytest.raises(ValidationError):
        TranslationRequestParser().parse(payload)  # type: ignore[arg-type]


@pytest.mark.parametrize("text", ["", "   ", None, 123])
def test_rejects_missing_text(text: object) -> None:
    with pytest.raises(ValidationError) as error:
        TranslationRequestParser().parse({"text": text})
    assert error.value.field == "text"


def test_rejects_too_long_text() -> None:
    with pytest.raises(ValidationError):
        TranslationRequestParser(max_text_chars=10).parse({"text": "a" * 11})


def test_rejects_bad_glossary() -> None:
    with pytest.raises(ValidationError):
        TranslationRequestParser().parse({"text": "hi", "glossary": {"a": 1}})


def test_rejects_too_many_glossary_entries() -> None:
    glossary = {f"term{index}": f"值{index}" for index in range(51)}
    with pytest.raises(ValidationError):
        TranslationRequestParser().parse({"text": "hi", "glossary": glossary})


def test_rejects_non_boolean_flag() -> None:
    with pytest.raises(ValidationError):
        TranslationRequestParser().parse({"text": "hi", "preserve_formatting": "yes"})
