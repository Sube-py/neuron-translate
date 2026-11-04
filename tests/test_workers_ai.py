from __future__ import annotations

import asyncio

import pytest

from errors import ProviderError
from models import TokenUsage
from response_parser import WorkersAiResponseParser
from workers_ai import WorkersAiProvider

MESSAGES = [
    {"role": "system", "content": "translate"},
    {"role": "user", "content": "Hello"},
]


class FakeBinding:
    def __init__(self, response: object) -> None:
        self.response = response
        self.calls: list[tuple[object, ...]] = []

    async def run(self, *args: object) -> object:
        self.calls.append(args)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def make_provider(binding: FakeBinding, **kwargs) -> WorkersAiProvider:
    return WorkersAiProvider(binding, "@cf/test/model", "gw", **kwargs)


def test_complete_returns_parsed_text_and_usage() -> None:
    binding = FakeBinding(
        {"response": " 你好 ", "usage": {"prompt_tokens": 3, "completion_tokens": 2}}
    )
    completion = asyncio.run(make_provider(binding).complete(MESSAGES))

    assert completion.text == "你好"
    assert completion.usage == TokenUsage(3, 2)
    model, inputs, options = binding.calls[0]
    assert model == "@cf/test/model"
    assert inputs["messages"] == MESSAGES
    assert inputs["temperature"] == 0.1
    assert options["gateway"] == {"id": "gw", "collectLog": True}


def test_metadata_and_cache_options_are_attached() -> None:
    binding = FakeBinding({"response": "ok"})
    provider = make_provider(binding, cache_ttl=3600)
    asyncio.run(
        provider.complete(MESSAGES, metadata={"request_id": "r1", "chunk": "1/1"}, cache_key="hash")
    )

    gateway = binding.calls[0][2]["gateway"]
    assert gateway["cacheTtl"] == 3600
    assert gateway["cacheKey"] == "hash"
    assert gateway["metadata"] == {"request_id": "r1", "chunk": "1/1"}


def test_cache_options_are_skipped_when_disabled() -> None:
    binding = FakeBinding({"response": "ok"})
    asyncio.run(make_provider(binding, cache_ttl=0).complete(MESSAGES, cache_key="hash"))

    gateway = binding.calls[0][2]["gateway"]
    assert "cacheKey" not in gateway
    assert "cacheTtl" not in gateway


def test_binding_failures_become_provider_errors() -> None:
    with pytest.raises(ProviderError):
        asyncio.run(make_provider(FakeBinding(RuntimeError("boom"))).complete(MESSAGES))


def test_empty_translation_is_rejected() -> None:
    with pytest.raises(ProviderError) as error:
        asyncio.run(make_provider(FakeBinding({"response": "   "})).complete(MESSAGES))
    assert error.value.code == "empty_response"


def test_parser_supports_openai_style_choices() -> None:
    completion = WorkersAiResponseParser().parse(
        {
            "choices": [{"message": {"content": "bonjour"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }
    )
    assert completion.text == "bonjour"


def test_parser_supports_output_text_blocks() -> None:
    completion = WorkersAiResponseParser().parse(
        {"output": [{"content": [{"type": "output_text", "text": " hola "}]}]}
    )
    assert completion.text == "hola"


def test_parser_detects_cache_flag() -> None:
    assert WorkersAiResponseParser().parse({"response": "x", "cached": True}).cached is True
    assert WorkersAiResponseParser().parse({"response": "x"}).cached is False


class FakeEnv:
    def __init__(self, binding: object) -> None:
        self.AI = binding


def test_env_binding_is_resolved_lazily() -> None:
    from workers_ai import EnvBinding

    binding = FakeBinding({"response": "ok"})
    lazy = EnvBinding(FakeEnv(binding))

    assert binding.calls == []
    asyncio.run(WorkersAiProvider(lazy, "@cf/test/model", "gw").complete(MESSAGES))
    assert len(binding.calls) == 1


def test_missing_binding_surfaces_as_provider_error() -> None:
    from errors import ProviderError as Error
    from workers_ai import EnvBinding

    with pytest.raises(Error):
        asyncio.run(
            WorkersAiProvider(EnvBinding(object(), "AI"), "@cf/test/model", "gw").complete(MESSAGES)
        )


def test_parser_handles_content_parts_array() -> None:
    completion = WorkersAiResponseParser().parse(
        {
            "id": "x",
            "object": "chat.completion",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": " 你好 "}],
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3},
        }
    )

    assert completion.text == "你好"
    assert completion.usage.completion_tokens == 3


def test_parser_ignores_reasoning_only_responses() -> None:
    completion = WorkersAiResponseParser().parse(
        {"choices": [{"message": {"content": None, "reasoning": "thinking..."}}]}
    )

    assert completion.text == ""


def test_reasoning_only_response_reports_budget_exhausted() -> None:
    binding = FakeBinding(
        {"choices": [{"message": {"content": None, "reasoning": "Let me think about this..."}}]}
    )

    with pytest.raises(ProviderError) as error:
        asyncio.run(make_provider(binding).complete(MESSAGES))
    assert error.value.code == "reasoning_budget_exhausted"
    assert "max_tokens" in error.value.message


def test_max_tokens_is_omitted_when_not_configured() -> None:
    binding = FakeBinding({"response": "ok"})
    provider = make_provider(binding, max_output_tokens=None)

    asyncio.run(provider.complete(MESSAGES))

    assert "max_tokens" not in binding.calls[0][1]


def test_max_tokens_can_be_overridden_per_call() -> None:
    binding = FakeBinding({"response": "ok"})

    asyncio.run(make_provider(binding).complete(MESSAGES, max_tokens=4096))

    assert binding.calls[0][1]["max_tokens"] == 4096
