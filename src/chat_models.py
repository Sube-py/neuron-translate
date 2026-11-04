"""Domain models for the OpenAI-compatible chat endpoint."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from models import TokenUsage

SUPPORTED_ROLES = frozenset({"system", "user", "assistant", "developer", "tool"})


@dataclass(frozen=True, slots=True)
class ChatMessage:
    role: str
    content: str


@dataclass(frozen=True, slots=True)
class ChatRequest:
    """A normalised OpenAI chat completion request."""

    messages: tuple[ChatMessage, ...]
    model: str | None = None
    stream: bool = False
    include_usage: bool = False
    temperature: float | None = None
    max_tokens: int | None = None
    tone: str | None = None
    target_lang: str | None = None
    glossary: Mapping[str, str] = field(default_factory=dict)

    @property
    def has_translation_hints(self) -> bool:
        return bool(self.tone or self.target_lang or self.glossary)


@dataclass(frozen=True, slots=True)
class ChatResult:
    text: str
    model: str
    usage: TokenUsage
    duration_ms: int


@dataclass(frozen=True, slots=True)
class ChatOutcome:
    """What the HTTP layer needs to render a chat completion response."""

    result: ChatResult
    stream: bool
    include_usage: bool
    requested_model: str | None
