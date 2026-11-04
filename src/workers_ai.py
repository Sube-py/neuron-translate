"""Workers AI chat provider routed through AI Gateway."""

from __future__ import annotations

from typing import Any

from errors import ProviderError
from jsbridge import to_js
from provider import ChatProvider, Completion, Messages, Metadata
from response_parser import WorkersAiResponseParser, shape_of


class EnvBinding:
    """Resolves a binding on first use so requests unrelated to AI still work."""

    def __init__(self, env: Any, name: str = "AI") -> None:
        self._env = env
        self._name = name
        self._binding: Any = None

    def resolve(self) -> Any:
        if self._binding is None:
            self._binding = getattr(self._env, self._name)
        return self._binding

    async def run(self, *args: Any) -> Any:
        return await self.resolve().run(*args)


class WorkersAiProvider(ChatProvider):
    """Calls ``env.AI.run`` with AI Gateway options attached."""

    def __init__(
        self,
        binding: Any,
        model: str,
        gateway_id: str,
        *,
        temperature: float = 0.1,
        max_output_tokens: int = 2048,
        cache_ttl: int = 0,
        collect_logs: bool = True,
        parser: WorkersAiResponseParser | None = None,
    ) -> None:
        self._binding = binding
        self.model = model
        self.gateway_id = gateway_id
        self._temperature = temperature
        self._max_output_tokens = max_output_tokens
        self._cache_ttl = cache_ttl
        self._collect_logs = collect_logs
        self._parser = parser or WorkersAiResponseParser()

    def gateway_options(
        self,
        metadata: Metadata | None = None,
        cache_key: str | None = None,
    ) -> dict[str, Any]:
        gateway: dict[str, Any] = {
            "id": self.gateway_id,
            "collectLog": self._collect_logs,
        }
        if self._cache_ttl > 0 and cache_key:
            gateway["cacheTtl"] = self._cache_ttl
            gateway["cacheKey"] = cache_key
        if metadata:
            gateway["metadata"] = dict(metadata)
        return {"gateway": gateway}

    async def complete(
        self,
        messages: Messages,
        *,
        metadata: Metadata | None = None,
        cache_key: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        model: str | None = None,
    ) -> Completion:
        model_id = model or self.model
        inputs = {
            "messages": [dict(message) for message in messages],
            "temperature": self._temperature if temperature is None else temperature,
            "max_tokens": self._max_output_tokens if max_tokens is None else max_tokens,
        }

        try:
            raw = await self._binding.run(
                model_id,
                to_js(inputs),
                to_js(self.gateway_options(metadata, cache_key)),
            )
        except Exception as exc:
            raise ProviderError(f"Workers AI call failed: {exc}", code="upstream_error") from exc

        completion = self._parser.parse(raw)
        if not completion.text:
            raise ProviderError(
                f"Workers AI returned an empty translation (shape: {shape_of(raw)}).",
                code="empty_response",
            )
        return completion
