"""Worker entry point: wires settings, Workers AI providers and the HTTP layer."""

from __future__ import annotations

from typing import Any

from workers import Response, WorkerEntrypoint

from app import TranslationApp
from chat_app import ChatApp
from chat_service import ChatService
from chunking import TextChunker
from http_adapter import HttpAdapter, HttpResponse
from model_catalog import ModelCatalog
from observability import JsonLogger
from prompting import PromptBuilder
from settings import Settings
from translator import TranslationService
from workers_ai import EnvBinding, WorkersAiProvider


class Default(WorkerEntrypoint):
    async def fetch(self, request: Any) -> Response:
        if not is_api_request(request):
            return await self.env.ASSETS.fetch(request)

        settings = Settings.from_env(self.env)
        logger = JsonLogger()
        adapter = self._build_adapter(settings, logger)
        response = await adapter.handle(request)
        return to_workers_response(response)

    def _build_adapter(self, settings: Settings, logger: JsonLogger) -> HttpAdapter:
        provider = WorkersAiProvider(
            EnvBinding(self.env, "AI"),
            settings.model,
            settings.gateway_id,
            temperature=settings.temperature,
            max_output_tokens=settings.max_output_tokens,
            cache_ttl=settings.gateway_cache_ttl,
            collect_logs=settings.gateway_collect_logs,
        )
        translation_service = TranslationService(
            provider,
            PromptBuilder(),
            TextChunker(settings.chunk_chars),
            max_concurrency=settings.max_concurrency,
            max_output_tokens=settings.max_output_tokens,
        )
        catalog = ModelCatalog(settings.model)
        chat_service = ChatService(provider, default_model=settings.model, catalog=catalog)

        return HttpAdapter(
            settings,
            TranslationApp(settings, translation_service, logger, catalog=catalog),
            ChatApp(chat_service, logger),
            logger,
        )


API_PREFIXES = ("/api/", "/v1/", "/translate", "/healthz", "/health")


def is_api_request(request: Any) -> bool:
    from urllib.parse import urlsplit

    path = urlsplit(str(getattr(request, "url", "/"))).path or "/"
    return path.startswith(API_PREFIXES)


def to_workers_response(response: HttpResponse) -> Response:
    headers = {"content-type": response.content_type, **response.headers}
    body = response.body
    if isinstance(body, (dict, list)):
        return Response.json(body, status=response.status, headers=headers)
    return Response("" if body is None else body, status=response.status, headers=headers)
