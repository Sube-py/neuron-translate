"""Shared test doubles."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from models import TokenUsage
from provider import Completion, Metadata


@dataclass
class FakeProvider:
    """Records calls and returns a deterministic translation."""

    model: str = "@cf/fake/model"
    gateway_id: str = "test-gateway"
    prefix: str = "T:"
    usage: TokenUsage = field(default_factory=lambda: TokenUsage(10, 5))
    cached: bool = False
    error: Exception | None = None
    calls: list[dict[str, object]] = field(default_factory=list)

    async def complete(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        metadata: Metadata | None = None,
        cache_key: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        model: str | None = None,
    ) -> Completion:
        if self.error is not None:
            raise self.error
        self.calls.append(
            {
                "messages": list(messages),
                "metadata": dict(metadata or {}),
                "cache_key": cache_key,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "model": model or self.model,
            }
        )
        return Completion(
            text=f"{self.prefix}{messages[-1]['content']}",
            usage=self.usage,
            cached=self.cached,
        )


@dataclass
class FakeHeaders:
    values: dict[str, str] = field(default_factory=dict)

    def get(self, name: str, default: str | None = None) -> str | None:
        return self.values.get(name.lower(), default)


@dataclass
class FakeRequest:
    method: str = "GET"
    url: str = "https://example.com/"
    headers: FakeHeaders = field(default_factory=FakeHeaders)
    payload: object = None
    json_error: Exception | None = None

    async def json(self) -> object:
        if self.json_error is not None:
            raise self.json_error
        return self.payload
