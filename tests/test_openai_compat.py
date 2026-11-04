from __future__ import annotations

import asyncio
import json

import pytest

from chat_service import ChatService
from chat_validation import ChatRequestParser
from errors import ValidationError
from fakes import FakeProvider

MESSAGES = [{"role": "user", "content": "Translate to Chinese: hello"}]


def test_parses_minimal_openai_body() -> None:
    request = ChatRequestParser().parse({"messages": MESSAGES})

    assert len(request.messages) == 1
    assert request.messages[0].content == "Translate to Chinese: hello"
    assert request.stream is False
    assert request.model is None
    assert request.temperature is None


def test_parses_full_openai_body() -> None:
    request = ChatRequestParser().parse(
        {
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": "You translate."},
                {"role": "user", "content": [{"type": "text", "text": "hi"}]},
            ],
            "stream": True,
            "stream_options": {"include_usage": True},
            "temperature": 5,
            "max_tokens": 999999,
            "target_lang": "zh-CN",
            "tone": "formal",
            "glossary": {"workers": "无服务器"},
            "presence_penalty": 0.5,
        }
    )

    assert [message.role for message in request.messages] == ["system", "user"]
    assert request.messages[1].content == "hi"
    assert request.stream is True
    assert request.include_usage is True
    assert request.temperature == 2.0
    assert request.max_tokens == 8192
    assert request.target_lang == "zh-CN"
    assert request.glossary == {"workers": "无服务器"}


@pytest.mark.parametrize("payload", [None, [], "x"])
def test_rejects_non_object_body(payload: object) -> None:
    with pytest.raises(ValidationError):
        ChatRequestParser().parse(payload)  # type: ignore[arg-type]


@pytest.mark.parametrize("messages", [None, [], "hello", [{"role": "user"}]])
def test_rejects_invalid_messages(messages: object) -> None:
    with pytest.raises(ValidationError):
        ChatRequestParser().parse({"messages": messages})


def test_rejects_unknown_role() -> None:
    with pytest.raises(ValidationError):
        ChatRequestParser().parse({"messages": [{"role": "wizard", "content": "hi"}]})


def test_rejects_too_long_conversation() -> None:
    with pytest.raises(ValidationError):
        ChatRequestParser(max_text_chars=5).parse({"messages": MESSAGES})


def test_service_forwards_messages_and_maps_model() -> None:
    provider = FakeProvider()
    service = ChatService(provider, default_model="@cf/meta/default")
    request = ChatRequestParser().parse({"model": "gpt-4o-mini", "messages": MESSAGES})

    outcome = asyncio.run(service.complete(request, request_id="req-1"))

    assert outcome.result.text == "T:Translate to Chinese: hello"
    assert outcome.result.model == "@cf/meta/default"
    assert outcome.requested_model == "gpt-4o-mini"
    sent = provider.calls[0]["messages"]
    assert sent[-1]["role"] == "user"
    assert provider.calls[0]["metadata"]["mode"] == "chat"


def test_service_keeps_explicit_cf_model() -> None:
    provider = FakeProvider()
    service = ChatService(provider, default_model="@cf/meta/default")
    request = ChatRequestParser().parse({"model": "@cf/meta/custom", "messages": MESSAGES})

    assert service.resolve_model(request) == "@cf/meta/custom"


def test_service_appends_translation_rules() -> None:
    provider = FakeProvider()
    service = ChatService(provider)
    request = ChatRequestParser().parse(
        {
            "messages": MESSAGES,
            "target_lang": "zh-CN",
            "tone": "formal",
            "glossary": {"edge": "边缘"},
        }
    )

    asyncio.run(service.complete(request, request_id="req-2"))

    system = provider.calls[0]["messages"][-1]
    assert system["role"] == "system"
    assert "Translate the result into zh-CN." in system["content"]
    assert "tone: formal" in system["content"]
    assert "edge => 边缘" in system["content"]


def test_service_forwards_temperature_and_max_tokens() -> None:
    provider = FakeProvider()
    service = ChatService(provider)
    request = ChatRequestParser().parse(
        {"messages": MESSAGES, "temperature": 0.3, "max_tokens": 128}
    )

    asyncio.run(service.complete(request, request_id="req-3"))

    assert provider.calls[0]["temperature"] == 0.3
    assert provider.calls[0]["max_tokens"] == 128


def test_request_without_hints_keeps_messages_untouched() -> None:
    provider = FakeProvider()
    service = ChatService(provider)

    asyncio.run(service.complete(ChatRequestParser().parse({"messages": MESSAGES}), request_id="r"))

    assert [m["role"] for m in provider.calls[0]["messages"]] == ["user"]


def test_stream_body_contains_deltas_and_done() -> None:
    from openai_format import OpenAiFormatter

    provider = FakeProvider()
    service = ChatService(provider)
    outcome = asyncio.run(
        service.complete(ChatRequestParser().parse({"messages": MESSAGES}), request_id="r9")
    )

    body = OpenAiFormatter().stream_body(
        outcome.result, request_id="r9", created=1, include_usage=True
    )
    events = [line for line in body.split("\n") if line.startswith("data: ")]

    assert events[-1] == "data: [DONE]"
    payloads = [json.loads(event[len("data: ") :]) for event in events[:-1]]
    assert payloads[0]["choices"][0]["delta"] == {"role": "assistant"}
    assert payloads[1]["choices"][0]["delta"]["content"] == "T:Translate to Chinese: hello"
    assert payloads[2]["choices"][0]["finish_reason"] == "stop"
    assert payloads[2]["usage"]["total_tokens"] == 15


def test_models_payload_lists_default_model() -> None:
    from openai_format import OpenAiFormatter

    service = ChatService(FakeProvider(), default_model="@cf/meta/default")
    payload = OpenAiFormatter().models(service.list_models(), created=5)

    assert payload["object"] == "list"
    assert payload["data"][0]["id"] == "@cf/fake/model"
    assert payload["data"][0]["object"] == "model"


def test_explicit_cf_model_is_used_for_the_call() -> None:
    provider = FakeProvider()
    service = ChatService(provider, default_model="@cf/meta/default")
    request = ChatRequestParser().parse({"model": "@cf/meta/custom", "messages": MESSAGES})

    asyncio.run(service.complete(request, request_id="req-4"))

    assert provider.calls[0]["model"] == "@cf/meta/custom"
