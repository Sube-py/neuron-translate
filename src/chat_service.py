"""OpenAI-compatible chat completion use case."""

from __future__ import annotations

import hashlib
import json
import time

from chat_models import ChatMessage, ChatOutcome, ChatRequest, ChatResult
from errors import ApiError, ProviderError
from provider import ChatProvider
from settings import DEFAULT_MODEL


class ChatService:
    """Proxies an OpenAI chat request to Workers AI through AI Gateway.

    The client usually supplies its own translation instructions, so the
    conversation is forwarded unchanged. Optional ``target_lang`` / ``tone`` /
    ``glossary`` additions are appended as extra system rules.
    """

    def __init__(self, provider: ChatProvider, *, default_model: str = DEFAULT_MODEL) -> None:
        self._provider = provider
        self._default_model = default_model

    @property
    def model(self) -> str:
        return self._provider.model

    def list_models(self) -> list[str]:
        models = [self.model]
        if self._default_model not in models:
            models.append(self._default_model)
        return models

    def resolve_model(self, request: ChatRequest) -> str:
        """Map whatever model id the client sent onto a Workers AI model."""
        requested = request.model
        if requested and requested.startswith("@cf/"):
            return requested
        return self._default_model

    async def complete(self, request: ChatRequest, *, request_id: str) -> ChatOutcome:
        started = time.monotonic()
        messages = self._messages(request)
        model = self.resolve_model(request)

        try:
            completion = await self._provider.complete(
                [{"role": message.role, "content": message.content} for message in messages],
                metadata=self._metadata(request, request_id, messages),
                cache_key=self._cache_key(messages, request),
                temperature=request.temperature,
                max_tokens=request.max_tokens,
                model=model,
            )
        except ApiError:
            raise
        except Exception as exc:
            raise ProviderError(f"Chat completion failed: {exc}") from exc

        return ChatOutcome(
            result=ChatResult(
                text=completion.text,
                model=model,
                usage=completion.usage,
                duration_ms=int((time.monotonic() - started) * 1000),
            ),
            stream=request.stream,
            include_usage=request.include_usage,
            requested_model=request.model,
        )

    def _messages(self, request: ChatRequest) -> tuple[ChatMessage, ...]:
        extra = self._translation_rules(request)
        if not extra:
            return request.messages
        return (*request.messages, ChatMessage(role="system", content=extra))

    @staticmethod
    def _translation_rules(request: ChatRequest) -> str:
        lines: list[str] = []
        if request.target_lang:
            lines.append(f"Translate the result into {request.target_lang}.")
        if request.tone:
            lines.append(f"Match the requested tone: {request.tone}.")
        if request.glossary:
            lines.append("Always use these glossary translations verbatim:")
            lines.extend(
                f"- {term} => {translated}" for term, translated in request.glossary.items()
            )
        if not lines:
            return ""
        return "\n".join(["Additional rules:", *lines])

    @staticmethod
    def _metadata(
        request: ChatRequest, request_id: str, messages: tuple[ChatMessage, ...]
    ) -> dict[str, str | int | bool]:
        """AI Gateway accepts at most five metadata keys."""
        return {
            "request_id": request_id,
            "mode": "chat",
            "messages": len(messages),
            "chars": sum(len(message.content) for message in messages),
            "stream": request.stream,
        }

    def _cache_key(self, messages: tuple[ChatMessage, ...], request: ChatRequest) -> str:
        fingerprint = json.dumps(
            {
                "model": request.model or self._default_model,
                "messages": [[message.role, message.content] for message in messages],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
