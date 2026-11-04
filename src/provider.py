"""Provider abstraction so the translation service stays transport agnostic."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from models import TokenUsage

Messages = Sequence[Mapping[str, str]]
Metadata = Mapping[str, str | int | bool]


@dataclass(frozen=True, slots=True)
class Completion:
    text: str
    usage: TokenUsage = field(default_factory=TokenUsage)
    cached: bool = False


@runtime_checkable
class ChatProvider(Protocol):
    """A model that can complete a chat-style conversation."""

    model: str

    async def complete(
        self,
        messages: Messages,
        *,
        metadata: Metadata | None = None,
        cache_key: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        model: str | None = None,
    ) -> Completion: ...
