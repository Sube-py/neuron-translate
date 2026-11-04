"""Application layer: transport agnostic translation use cases."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from observability import JsonLogger
from settings import Settings
from translator import TranslationService
from validation import TranslationRequestParser


class TranslationApp:
    """Coordinates validation, translation and observability."""

    def __init__(
        self,
        settings: Settings,
        service: TranslationService,
        logger: JsonLogger | None = None,
        parser: TranslationRequestParser | None = None,
    ) -> None:
        self._settings = settings
        self._service = service
        self._logger = logger or JsonLogger()
        self._parser = parser or TranslationRequestParser(settings.max_text_chars)

    async def translate(
        self, payload: Mapping[str, Any] | None, *, request_id: str
    ) -> dict[str, Any]:
        request = self._parser.parse(payload)
        result = await self._service.translate(request, request_id=request_id)
        self._logger.info(
            "translation.completed",
            request_id=request_id,
            target_lang=request.target_lang,
            source_lang=request.source_lang,
            model=result.model,
            gateway=result.gateway_id,
            chunks=result.chunk_count,
            cached_chunks=result.cached_chunks,
            input_chars=len(request.text),
            output_chars=len(result.text),
            duration_ms=result.duration_ms,
            tokens=result.usage.to_payload(),
        )
        return {
            "request_id": request_id,
            "translation": result.text,
            "meta": result.to_payload(),
        }

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "trans",
            "model": self._settings.model,
            "gateway": self._settings.gateway_id,
            "tracing": {"worker_traces": True, "ai_gateway_logs": True},
        }
