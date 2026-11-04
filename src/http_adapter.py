"""HTTP adapter: routes, CORS, authentication and error rendering."""

from __future__ import annotations

import hmac
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from app import TranslationApp
from chat_app import ChatApp
from errors import ApiError, AuthError, NotFoundError, PayloadTooLargeError, ValidationError
from jsbridge import to_py
from observability import JsonLogger
from openai_format import OpenAiFormatter
from playground import render_playground
from settings import Settings

MAX_BODY_BYTES = 2_000_000
JSON_CONTENT_TYPE = "application/json; charset=utf-8"
HTML_CONTENT_TYPE = "text/html; charset=utf-8"
SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8"
CHAT_SUFFIXES = ("/chat/completions",)
MODELS_SUFFIXES = ("/models",)
OPENAI_PREFIXES = ("/v1/", "/chat/", "/models", "/openai/")


@dataclass(slots=True)
class HttpResponse:
    status: int
    body: Any = None
    headers: dict[str, str] = field(default_factory=dict)
    content_type: str = JSON_CONTENT_TYPE


class CorsPolicy:
    def __init__(self, allowed_origins: tuple[str, ...]) -> None:
        self._allowed = allowed_origins or ("*",)

    def headers(self, origin: str | None) -> dict[str, str]:
        if "*" in self._allowed:
            allowed = "*"
        elif origin and origin in self._allowed:
            allowed = origin
        else:
            allowed = self._allowed[0] if self._allowed else "*"
        return {
            "access-control-allow-origin": allowed,
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type, authorization, x-api-key, x-request-id",
            "access-control-max-age": "86400",
            "vary": "origin",
        }


class ApiKeyGuard:
    """Optional bearer/API-key gate for the translate endpoint."""

    def __init__(self, expected_token: str | None) -> None:
        self._expected = expected_token

    def verify(self, authorization: str | None, api_key: str | None) -> None:
        if not self._expected:
            return

        token = self._extract(authorization) or (api_key or "").strip()
        if not token:
            raise AuthError(
                "Missing credentials. Send 'Authorization: Bearer <token>' or 'X-API-Key'."
            )
        if not hmac.compare_digest(token, self._expected):
            raise AuthError("Invalid API token.")

    @staticmethod
    def _extract(authorization: str | None) -> str | None:
        if not authorization:
            return None
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() != "bearer":
            return None
        return value.strip() or None


class HttpAdapter:
    """Translates a Workers ``Request`` into an :class:`HttpResponse`."""

    def __init__(
        self,
        settings: Settings,
        app: TranslationApp,
        chat_app: ChatApp,
        logger: JsonLogger | None = None,
        formatter: OpenAiFormatter | None = None,
    ) -> None:
        self._settings = settings
        self._app = app
        self._chat_app = chat_app
        self._logger = logger or JsonLogger()
        self._cors = CorsPolicy(settings.allowed_origins)
        self._guard = ApiKeyGuard(settings.api_token)
        self._formatter = formatter or OpenAiFormatter()

    async def handle(self, request: Any) -> HttpResponse:
        request_id = self._request_id(request)
        method = str(self._attr(request, "method", "GET")).upper()
        path = urlsplit(str(self._attr(request, "url", "/"))).path or "/"
        cors = self._cors.headers(self._header(request, "origin"))
        cors["x-request-id"] = request_id

        try:
            if method == "OPTIONS":
                return HttpResponse(status=204, headers=cors)

            if method == "GET" and path in {"/", "/playground"}:
                if not self._settings.playground_enabled:
                    raise NotFoundError("Not found.")
                return HttpResponse(
                    status=200,
                    body=render_playground(),
                    headers=cors,
                    content_type=HTML_CONTENT_TYPE,
                )

            if method == "GET" and path in {"/health", "/healthz"}:
                return HttpResponse(status=200, body=self._app.health(), headers=cors)

            if any(path.endswith(suffix) for suffix in MODELS_SUFFIXES):
                if method != "GET":
                    raise ApiError("Method not allowed.", code="method_not_allowed", status=405)
                return HttpResponse(
                    status=200,
                    body=self._formatter.models(self._chat_app.models()),
                    headers=cors,
                )

            if any(path.endswith(suffix) for suffix in CHAT_SUFFIXES):
                if method != "POST":
                    raise ApiError("Method not allowed.", code="method_not_allowed", status=405)
                return await self._chat(request, request_id=request_id, headers=cors)

            if path == "/translate":
                if method != "POST":
                    raise ApiError("Method not allowed.", code="method_not_allowed", status=405)
                return await self._translate(request, request_id=request_id, headers=cors)

            raise NotFoundError(f"No route matches {method} {path}.")
        except ApiError as exc:
            self._logger.warning(
                "request.failed",
                request_id=request_id,
                method=method,
                path=path,
                code=exc.code,
                status=exc.status,
                message=exc.message,
            )
            return HttpResponse(
                status=exc.status,
                body=self._error_body(exc, path=path, request_id=request_id),
                headers=cors,
            )
        except Exception as exc:
            self._logger.error(
                "request.crashed",
                request_id=request_id,
                method=method,
                path=path,
                message=str(exc),
            )
            internal = ApiError("Unexpected error.", code="internal_error", status=500)
            return HttpResponse(
                status=500,
                body=self._error_body(internal, path=path, request_id=request_id),
                headers=cors,
            )

    def _error_body(self, error: ApiError, *, path: str, request_id: str) -> dict[str, Any]:
        if path.startswith(OPENAI_PREFIXES):
            return self._formatter.error(error, request_id=request_id)
        return {"request_id": request_id, **error.to_payload()}

    async def _chat(
        self, request: Any, *, request_id: str, headers: dict[str, str]
    ) -> HttpResponse:
        self._guard.verify(
            self._header(request, "authorization"), self._header(request, "x-api-key")
        )
        payload = await self._json_body(request)
        outcome = await self._chat_app.chat(payload, request_id=request_id)
        created = int(time.time())

        if outcome.stream:
            return HttpResponse(
                status=200,
                body=self._formatter.stream_body(
                    outcome.result,
                    request_id=request_id,
                    created=created,
                    include_usage=outcome.include_usage,
                ),
                headers={**headers, "cache-control": "no-cache"},
                content_type=SSE_CONTENT_TYPE,
            )

        return HttpResponse(
            status=200,
            body=self._formatter.completion(outcome.result, request_id=request_id, created=created),
            headers=headers,
        )

    async def _translate(
        self, request: Any, *, request_id: str, headers: dict[str, str]
    ) -> HttpResponse:
        self._guard.verify(
            self._header(request, "authorization"), self._header(request, "x-api-key")
        )
        payload = await self._json_body(request)
        body = await self._app.translate(payload, request_id=request_id)
        return HttpResponse(status=200, body=body, headers=headers)

    async def _json_body(self, request: Any) -> Mapping[str, Any]:
        content_length = self._header(request, "content-length")
        if content_length and content_length.isdigit() and int(content_length) > MAX_BODY_BYTES:
            raise PayloadTooLargeError("Request body is larger than 2 MB.")

        try:
            payload = to_py(await request.json())
        except Exception as exc:
            raise ValidationError("Request body must be valid JSON.") from exc

        if not isinstance(payload, Mapping):
            raise ValidationError("Request body must be a JSON object.")
        return payload

    def _request_id(self, request: Any) -> str:
        supplied = self._header(request, "x-request-id")
        if supplied:
            cleaned = supplied.strip()[:64]
            if cleaned:
                return cleaned
        ray = self._header(request, "cf-ray")
        if ray:
            return ray.strip()[:64]
        return uuid.uuid4().hex[:16]

    @staticmethod
    def _header(request: Any, name: str) -> str | None:
        headers = HttpAdapter._attr(request, "headers", None)
        getter = getattr(headers, "get", None)
        if not callable(getter):
            return None
        try:
            value = getter(name)
        except Exception:
            return None
        if value is None:
            return None
        text = str(value)
        return None if text.lower() in {"", "none", "undefined", "null"} else text

    @staticmethod
    def _attr(obj: Any, name: str, default: Any = None) -> Any:
        try:
            value = getattr(obj, name)
        except Exception:
            return default
        return default if value is None else value
