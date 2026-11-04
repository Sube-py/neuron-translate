"""Application layer for the OpenAI-compatible chat endpoint."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from chat_models import ChatOutcome
from chat_service import ChatService
from chat_validation import ChatRequestParser
from observability import JsonLogger


class ChatApp:
    """Validates an OpenAI chat request and forwards it to Workers AI."""

    def __init__(
        self,
        service: ChatService,
        logger: JsonLogger | None = None,
        parser: ChatRequestParser | None = None,
    ) -> None:
        self._service = service
        self._logger = logger or JsonLogger()
        self._parser = parser or ChatRequestParser()

    def models(self) -> list[str]:
        return self._service.list_models()

    async def chat(self, payload: Mapping[str, Any] | None, *, request_id: str) -> ChatOutcome:
        request = self._parser.parse(payload)
        outcome = await self._service.complete(request, request_id=request_id)
        self._logger.info(
            "chat.completed",
            request_id=request_id,
            model=outcome.result.model,
            requested_model=outcome.requested_model,
            stream=outcome.stream,
            messages=len(request.messages),
            duration_ms=outcome.result.duration_ms,
            tokens=outcome.result.usage.to_payload(),
        )
        return outcome
