"""Domain models for the translation service."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class TranslationRequest:
    text: str
    target_lang: str
    source_lang: str = "auto"
    tone: str | None = None
    glossary: Mapping[str, str] = field(default_factory=dict)
    preserve_formatting: bool = True
    model: str | None = None


@dataclass(frozen=True, slots=True)
class TextChunk:
    """A piece of the source text plus the separator that follows it."""

    text: str
    separator: str = ""


@dataclass(frozen=True, slots=True)
class TokenUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0

    def __add__(self, other: TokenUsage) -> TokenUsage:
        return TokenUsage(
            prompt_tokens=self.prompt_tokens + other.prompt_tokens,
            completion_tokens=self.completion_tokens + other.completion_tokens,
        )

    def to_payload(self) -> dict[str, int]:
        return {
            "prompt": self.prompt_tokens,
            "completion": self.completion_tokens,
            "total": self.prompt_tokens + self.completion_tokens,
        }


@dataclass(frozen=True, slots=True)
class TranslationResult:
    text: str
    chunk_count: int
    cached_chunks: int
    model: str
    gateway_id: str
    usage: TokenUsage
    duration_ms: int

    def to_payload(self) -> dict[str, object]:
        return {
            "model": self.model,
            "gateway": self.gateway_id,
            "chunks": self.chunk_count,
            "cached_chunks": self.cached_chunks,
            "tokens": self.usage.to_payload(),
            "duration_ms": self.duration_ms,
        }
