"""OpenAI-compatible chat completion responses and SSE framing."""

from __future__ import annotations

import json
import time
from typing import Any

from chat_models import ChatResult
from errors import ApiError

SSE_DONE = "data: [DONE]\n\n"


class OpenAiFormatter:
    """Renders chat completions in the OpenAI wire format."""

    def __init__(self, owned_by: str = "cloudflare") -> None:
        self._owned_by = owned_by

    def completion(self, result: ChatResult, *, request_id: str, created: int) -> dict:
        return {
            "id": self.completion_id(request_id),
            "object": "chat.completion",
            "created": created,
            "model": result.model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": result.text},
                    "logprobs": None,
                    "finish_reason": "stop",
                }
            ],
            "usage": self._usage(result),
        }

    def stream_body(
        self, result: ChatResult, *, request_id: str, created: int, include_usage: bool
    ) -> str:
        completion_id = self.completion_id(request_id)
        events = [
            self._chunk(completion_id, result.model, created, delta={"role": "assistant"}),
            self._chunk(completion_id, result.model, created, delta={"content": result.text}),
            self._chunk(
                completion_id,
                result.model,
                created,
                delta={},
                finish_reason="stop",
                usage=self._usage(result) if include_usage else None,
            ),
        ]
        return "".join(self._event(event) for event in events) + SSE_DONE

    def models(self, model_ids: list[str], *, created: int | None = None) -> dict:
        stamp = created if created is not None else int(time.time())
        return {
            "object": "list",
            "data": [
                {
                    "id": model_id,
                    "object": "model",
                    "created": stamp,
                    "owned_by": self._owned_by,
                }
                for model_id in model_ids
            ],
        }

    def error(self, error: ApiError, *, request_id: str) -> dict:
        return {
            "error": {
                "message": error.message,
                "type": self._error_type(error),
                "param": error.field,
                "code": error.code,
            },
            "request_id": request_id,
        }

    @staticmethod
    def completion_id(request_id: str) -> str:
        return f"chatcmpl-{request_id}"

    @staticmethod
    def _error_type(error: ApiError) -> str:
        if error.status == 401:
            return "authentication_error"
        if error.status == 404:
            return "not_found_error"
        if error.status == 429:
            return "rate_limit_error"
        if error.status >= 500:
            return "api_error"
        return "invalid_request_error"

    @staticmethod
    def _usage(result: ChatResult) -> dict[str, int]:
        return {
            "prompt_tokens": result.usage.prompt_tokens,
            "completion_tokens": result.usage.completion_tokens,
            "total_tokens": result.usage.prompt_tokens + result.usage.completion_tokens,
        }

    def _chunk(
        self,
        completion_id: str,
        model: str,
        created: int,
        *,
        delta: dict[str, Any],
        finish_reason: str | None = None,
        usage: dict[str, int] | None = None,
    ) -> dict[str, Any]:
        chunk: dict[str, Any] = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [
                {"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish_reason}
            ],
        }
        if usage is not None:
            chunk["usage"] = usage
        return chunk

    @staticmethod
    def _event(payload: dict[str, Any]) -> str:
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
