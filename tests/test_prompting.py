from __future__ import annotations

from models import TranslationRequest
from prompting import PromptBuilder, language_label


def build_request(**overrides) -> TranslationRequest:
    defaults = {"text": "Hello", "target_lang": "zh-CN"}
    return TranslationRequest(**{**defaults, **overrides})


def test_language_label_maps_codes() -> None:
    assert language_label("zh-CN") == "Simplified Chinese (zh-CN)"
    assert language_label("auto") == "auto-detected source language"
    assert language_label("xx-unknown") == "xx-unknown"


def test_system_prompt_contains_direction_and_rules() -> None:
    prompt = PromptBuilder().system_prompt(build_request(source_lang="en", target_lang="zh-CN"))

    assert "English (en)" in prompt
    assert "Simplified Chinese (zh-CN)" in prompt
    assert "Output only the translated text" in prompt
    assert "Markdown" in prompt


def test_prompt_includes_tone_and_glossary() -> None:
    prompt = PromptBuilder().system_prompt(
        build_request(tone="formal", glossary={"workers": "无服务器"})
    )

    assert "Match the requested tone: formal" in prompt
    assert "workers => 无服务器" in prompt


def test_prompt_skips_formatting_rules_when_disabled() -> None:
    prompt = PromptBuilder().system_prompt(build_request(preserve_formatting=False))

    assert "Markdown" not in prompt


def test_build_returns_system_and_user_messages() -> None:
    messages = PromptBuilder().build(build_request(), "Hello world")

    assert [message["role"] for message in messages] == ["system", "user"]
    assert messages[1]["content"] == "Hello world"
