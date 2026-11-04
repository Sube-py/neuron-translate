from __future__ import annotations

import asyncio

import pytest

from chunking import TextChunker
from errors import ApiError, ProviderError
from fakes import FakeProvider
from models import TranslationRequest
from translator import TranslationService


def run(coroutine):
    return asyncio.run(coroutine)


def make_service(provider: FakeProvider, chunk_chars: int = 1000, concurrency: int = 4):
    return TranslationService(
        provider,
        chunker=TextChunker(chunk_chars=chunk_chars),
        max_concurrency=concurrency,
    )


def test_translates_single_chunk() -> None:
    provider = FakeProvider()
    result = run(
        make_service(provider).translate(TranslationRequest("Hello", "zh"), request_id="r1")
    )

    assert result.text == "T:Hello"
    assert result.chunk_count == 1
    assert result.cached_chunks == 0
    assert result.model == provider.model
    assert result.gateway_id == provider.gateway_id
    assert result.usage.prompt_tokens == 10


def test_reassembles_multiple_chunks_and_sends_metadata() -> None:
    provider = FakeProvider()
    text = "A" * 90 + "\n\n" + "B" * 90
    result = run(
        make_service(provider, chunk_chars=100).translate(
            TranslationRequest(text, "ja", source_lang="en"), request_id="req-42"
        )
    )

    assert result.text == "T:" + "A" * 90 + "\n\nT:" + "B" * 90
    assert result.chunk_count == 2
    assert result.usage.prompt_tokens == 20
    assert [call["metadata"]["chunk"] for call in provider.calls] == ["1/2", "2/2"]
    assert provider.calls[0]["metadata"] == {
        "request_id": "req-42",
        "target_lang": "ja",
        "source_lang": "en",
        "chunk": "1/2",
        "chars": 90,
    }


def test_cache_key_is_stable_and_content_sensitive() -> None:
    provider = FakeProvider()
    service = make_service(provider)

    run(service.translate(TranslationRequest("Hello", "zh"), request_id="a"))
    run(service.translate(TranslationRequest("Hello", "zh"), request_id="b"))
    run(service.translate(TranslationRequest("Hello", "fr"), request_id="c"))

    first, second, third = (call["cache_key"] for call in provider.calls)
    assert first == second
    assert first != third


def test_counts_cached_chunks() -> None:
    provider = FakeProvider(cached=True)
    result = run(make_service(provider).translate(TranslationRequest("Hi", "de"), request_id="r"))

    assert result.cached_chunks == 1


def test_wraps_provider_failures() -> None:
    provider = FakeProvider(error=RuntimeError("boom"))

    with pytest.raises(ProviderError) as error:
        run(make_service(provider).translate(TranslationRequest("Hi", "de"), request_id="r"))
    assert "boom" in error.value.message


def test_keeps_typed_api_errors_and_marks_chunk() -> None:
    provider = FakeProvider(error=ApiError("nope", code="nope", status=429))

    with pytest.raises(ApiError) as error:
        run(make_service(provider).translate(TranslationRequest("Hi", "de"), request_id="r"))
    assert error.value.code == "nope"
    assert error.value.field == "chunks[0]"
