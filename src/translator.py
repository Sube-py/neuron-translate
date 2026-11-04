"""Translation orchestration: chunking, concurrency, tracing metadata."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time

from chunking import TextChunker
from errors import ApiError, ProviderError
from models import TextChunk, TokenUsage, TranslationRequest, TranslationResult
from prompting import PromptBuilder
from provider import ChatProvider, Completion, Metadata


class TranslationService:
    """Translates a request chunk by chunk and reassembles the result."""

    def __init__(
        self,
        provider: ChatProvider,
        prompt_builder: PromptBuilder | None = None,
        chunker: TextChunker | None = None,
        *,
        max_concurrency: int = 4,
    ) -> None:
        self._provider = provider
        self._prompts = prompt_builder or PromptBuilder()
        self._chunker = chunker or TextChunker()
        self._max_concurrency = max(1, max_concurrency)

    async def translate(self, request: TranslationRequest, *, request_id: str) -> TranslationResult:
        started = time.monotonic()
        chunks = self._chunker.split(request.text)
        system_prompt = self._prompts.system_prompt(request)

        semaphore = asyncio.Semaphore(self._max_concurrency)

        async def run(index: int, chunk: TextChunk) -> Completion:
            async with semaphore:
                messages = [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": chunk.text},
                ]
                return await self._complete(
                    messages,
                    metadata=self._metadata(request, request_id, index, len(chunks), chunk),
                    cache_key=self._cache_key(request, system_prompt, chunk.text),
                    index=index,
                )

        completions = await asyncio.gather(
            *(run(index, chunk) for index, chunk in enumerate(chunks))
        )

        usage = TokenUsage()
        for completion in completions:
            usage += completion.usage

        text = "".join(
            f"{completion.text}{chunk.separator}"
            for chunk, completion in zip(chunks, completions, strict=True)
        )

        return TranslationResult(
            text=text.strip(),
            chunk_count=len(chunks),
            cached_chunks=sum(1 for completion in completions if completion.cached),
            model=self._provider.model,
            gateway_id=getattr(self._provider, "gateway_id", "default"),
            usage=usage,
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    async def _complete(
        self,
        messages: list[dict[str, str]],
        *,
        metadata: Metadata,
        cache_key: str,
        index: int,
    ) -> Completion:
        try:
            return await self._provider.complete(messages, metadata=metadata, cache_key=cache_key)
        except ApiError as exc:
            exc.field = exc.field or f"chunks[{index}]"
            raise
        except Exception as exc:
            raise ProviderError(
                f"Translation chunk {index} failed: {exc}", code="upstream_error"
            ) from exc

    @staticmethod
    def _metadata(
        request: TranslationRequest,
        request_id: str,
        index: int,
        total: int,
        chunk: TextChunk,
    ) -> Metadata:
        """AI Gateway allows five metadata keys per request."""
        return {
            "request_id": request_id,
            "target_lang": request.target_lang,
            "source_lang": request.source_lang,
            "chunk": f"{index + 1}/{total}",
            "chars": len(chunk.text),
        }

    def _cache_key(self, request: TranslationRequest, system_prompt: str, text: str) -> str:
        fingerprint = json.dumps(
            {
                "model": self._provider.model,
                "system": system_prompt,
                "text": text,
                "target_lang": request.target_lang,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
