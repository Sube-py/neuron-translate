from __future__ import annotations

import asyncio

import pytest

from app import TranslationApp
from chat_app import ChatApp
from chat_service import ChatService
from chunking import TextChunker
from fakes import FakeHeaders, FakeProvider, FakeRequest
from http_adapter import HttpAdapter
from observability import JsonLogger
from settings import Settings
from translator import TranslationService

logger = JsonLogger(enabled=False)


def make_adapter(
    provider: FakeProvider | None = None, **overrides
) -> tuple[HttpAdapter, FakeProvider]:
    provider = provider or FakeProvider()
    settings = Settings(**overrides)
    app = TranslationApp(
        settings,
        TranslationService(provider, chunker=TextChunker(1000)),
        logger,
    )
    chat_app = ChatApp(ChatService(provider, default_model=settings.model), logger)
    return HttpAdapter(settings, app, chat_app, logger), provider


def call(adapter: HttpAdapter, request: FakeRequest):
    return asyncio.run(adapter.handle(request))


def test_health_endpoint() -> None:
    adapter, _ = make_adapter()
    response = call(adapter, FakeRequest(method="GET", url="https://x.dev/healthz"))

    assert response.status == 200
    assert response.body["status"] == "ok"
    assert response.body["gateway"] == "default"
    assert response.headers["x-request-id"]


def test_translate_happy_path() -> None:
    adapter, provider = make_adapter()
    request = FakeRequest(
        method="POST",
        url="https://x.dev/translate",
        payload={"text": "Hello", "target_lang": "zh-CN"},
        headers=FakeHeaders({"x-request-id": "abc123"}),
    )

    response = call(adapter, request)

    assert response.status == 200
    assert response.body["translation"] == "T:Hello"
    assert response.body["request_id"] == "abc123"
    assert response.body["meta"]["model"] == provider.model
    assert response.headers["x-request-id"] == "abc123"


def test_cf_ray_is_used_as_request_id() -> None:
    adapter, _ = make_adapter()
    request = FakeRequest(
        method="POST",
        url="https://x.dev/translate",
        payload={"text": "Hello"},
        headers=FakeHeaders({"cf-ray": "8f2-LHR"}),
    )

    assert call(adapter, request).body["request_id"] == "8f2-LHR"


def test_missing_token_is_rejected() -> None:
    adapter, provider = make_adapter(api_token="secret")
    response = call(
        adapter,
        FakeRequest(method="POST", url="https://x.dev/translate", payload={"text": "Hi"}),
    )

    assert response.status == 401
    assert response.body["error"]["code"] == "unauthorized"
    assert provider.calls == []


def test_bearer_token_is_accepted() -> None:
    adapter, provider = make_adapter(api_token="secret")
    response = call(
        adapter,
        FakeRequest(
            method="POST",
            url="https://x.dev/translate",
            payload={"text": "Hi"},
            headers=FakeHeaders({"authorization": "Bearer secret"}),
        ),
    )

    assert response.status == 200
    assert len(provider.calls) == 1


def test_wrong_token_is_rejected() -> None:
    adapter, _ = make_adapter(api_token="secret")
    response = call(
        adapter,
        FakeRequest(
            method="POST",
            url="https://x.dev/translate",
            payload={"text": "Hi"},
            headers=FakeHeaders({"x-api-key": "nope"}),
        ),
    )

    assert response.status == 401


def test_preflight_returns_cors_headers() -> None:
    adapter, _ = make_adapter(allowed_origins=("https://app.example",))
    response = call(
        adapter,
        FakeRequest(
            method="OPTIONS",
            url="https://x.dev/translate",
            headers=FakeHeaders({"origin": "https://app.example"}),
        ),
    )

    assert response.status == 204
    assert response.headers["access-control-allow-origin"] == "https://app.example"


def test_invalid_json_body_is_rejected() -> None:
    adapter, _ = make_adapter()
    response = call(
        adapter,
        FakeRequest(
            method="POST",
            url="https://x.dev/translate",
            json_error=ValueError("bad json"),
        ),
    )

    assert response.status == 400
    assert response.body["error"]["code"] == "invalid_request"


def test_non_object_body_is_rejected() -> None:
    adapter, _ = make_adapter()
    response = call(
        adapter, FakeRequest(method="POST", url="https://x.dev/translate", payload=[1, 2])
    )

    assert response.status == 400


def test_validation_error_includes_field() -> None:
    adapter, _ = make_adapter()
    response = call(adapter, FakeRequest(method="POST", url="https://x.dev/translate", payload={}))

    assert response.status == 400
    assert response.body["error"]["field"] == "text"


def test_method_not_allowed() -> None:
    adapter, _ = make_adapter()
    response = call(adapter, FakeRequest(method="GET", url="https://x.dev/translate"))

    assert response.status == 405


def test_unknown_route_returns_404() -> None:
    adapter, _ = make_adapter()
    response = call(adapter, FakeRequest(method="GET", url="https://x.dev/nope"))

    assert response.status == 404
    assert response.body["error"]["code"] == "not_found"


def test_oversized_body_is_rejected() -> None:
    adapter, _ = make_adapter()
    response = call(
        adapter,
        FakeRequest(
            method="POST",
            url="https://x.dev/translate",
            payload={"text": "Hi"},
            headers=FakeHeaders({"content-length": "5000000"}),
        ),
    )

    assert response.status == 413


CHAT_BODY = {"messages": [{"role": "user", "content": "Say hello"}]}


def test_chat_completions_returns_openai_shape() -> None:
    adapter, provider = make_adapter()
    response = call(
        adapter,
        FakeRequest(
            method="POST",
            url="https://x.dev/v1/chat/completions",
            payload=CHAT_BODY,
            headers=FakeHeaders({"x-request-id": "c1"}),
        ),
    )

    assert response.status == 200
    assert response.body["object"] == "chat.completion"
    assert response.body["id"] == "chatcmpl-c1"
    assert response.body["choices"][0]["message"] == {
        "role": "assistant",
        "content": "T:Say hello",
    }
    assert response.body["choices"][0]["finish_reason"] == "stop"
    assert response.body["usage"]["total_tokens"] == 15
    assert provider.calls[0]["metadata"]["mode"] == "chat"


def test_chat_completions_streams_sse() -> None:
    adapter, _ = make_adapter()
    response = call(
        adapter,
        FakeRequest(
            method="POST",
            url="https://x.dev/v1/chat/completions",
            payload={**CHAT_BODY, "stream": True},
        ),
    )

    assert response.status == 200
    assert response.content_type.startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.body.rstrip().endswith("data: [DONE]")
    assert '"content": "T:Say hello"' in response.body


def test_chat_completions_accepts_path_without_v1() -> None:
    adapter, _ = make_adapter()
    response = call(
        adapter,
        FakeRequest(method="POST", url="https://x.dev/chat/completions", payload=CHAT_BODY),
    )

    assert response.status == 200
    assert response.body["object"] == "chat.completion"


def test_chat_errors_use_openai_error_shape() -> None:
    adapter, _ = make_adapter(api_token="secret")
    response = call(
        adapter,
        FakeRequest(method="POST", url="https://x.dev/v1/chat/completions", payload=CHAT_BODY),
    )

    assert response.status == 401
    assert response.body["error"]["type"] == "authentication_error"
    assert response.body["error"]["code"] == "unauthorized"


def test_chat_rejects_invalid_messages_with_openai_error() -> None:
    adapter, _ = make_adapter()
    response = call(
        adapter,
        FakeRequest(
            method="POST", url="https://x.dev/v1/chat/completions", payload={"messages": []}
        ),
    )

    assert response.status == 400
    assert response.body["error"]["param"] == "messages"


def test_models_endpoint() -> None:
    adapter, _ = make_adapter()
    response = call(adapter, FakeRequest(method="GET", url="https://x.dev/v1/models"))

    assert response.status == 200
    assert response.body["object"] == "list"
    assert response.body["data"][0]["id"] == "@cf/fake/model"


def test_models_endpoint_rejects_post() -> None:
    adapter, _ = make_adapter()

    assert call(adapter, FakeRequest(method="POST", url="https://x.dev/v1/models")).status == 405


@pytest.mark.parametrize(
    "path",
    ["/v1/chat/completions", "/chat/completions", "/openai/v1/chat/completions"],
)
def test_chat_route_accepts_common_client_paths(path: str) -> None:
    adapter, _ = make_adapter()
    response = call(
        adapter, FakeRequest(method="POST", url=f"https://x.dev{path}", payload=CHAT_BODY)
    )

    assert response.status == 200
    assert response.body["object"] == "chat.completion"


def test_request_logging_records_path_and_user_agent() -> None:
    from observability import JsonLogger

    class CapturingLogger(JsonLogger):
        def __init__(self) -> None:
            super().__init__(enabled=True)
            self.events: list[tuple[str, dict]] = []

        def _emit(self, level: str, event: str, fields: dict) -> None:
            self.events.append((event, fields))

    provider = FakeProvider()
    settings = Settings()
    logger = CapturingLogger()
    app = TranslationApp(settings, TranslationService(provider, chunker=TextChunker(1000)), logger)
    chat_app = ChatApp(ChatService(provider, default_model=settings.model), logger)
    adapter = HttpAdapter(settings, app, chat_app, logger)

    call(
        adapter,
        FakeRequest(
            method="POST",
            url="https://x.dev/v1/chat/completions",
            payload={"messages": [{"role": "user", "content": "hi"}]},
            headers=FakeHeaders({"user-agent": "Immersive-Translate/1.0"}),
        ),
    )

    events = dict(logger.events)
    completed = events["request.completed"]
    assert completed["path"] == "/v1/chat/completions"
    assert completed["status"] == 200
    assert completed["user_agent"].startswith("Immersive-Translate")
    assert "duration_ms" in completed


class FakeUsageClient:
    def __init__(self, report=None, error: Exception | None = None) -> None:
        self._report = report
        self._error = error

    async def fetch(self):
        if self._error is not None:
            raise self._error
        return self._report


def test_session_endpoint_returns_limits() -> None:
    adapter, _ = make_adapter()
    response = call(
        adapter,
        FakeRequest(
            method="GET",
            url="https://x.dev/api/verify",
            headers=FakeHeaders({"authorization": "Bearer"}),
        ),
    )

    assert response.status == 200
    assert response.body["ok"] is True
    assert response.body["limits"]["max_text_chars"] == 20000


def test_session_endpoint_requires_token() -> None:
    adapter, _ = make_adapter(api_token="secret")
    response = call(adapter, FakeRequest(method="GET", url="https://x.dev/api/verify"))

    assert response.status == 401


def test_usage_endpoint_reports_missing_configuration() -> None:
    adapter, _ = make_adapter()
    response = call(
        adapter,
        FakeRequest(
            method="GET",
            url="https://x.dev/api/usage",
            headers=FakeHeaders({"authorization": "Bearer"}),
        ),
    )

    assert response.status == 200
    assert response.body["configured"] is False
    assert "ANALYTICS_API_TOKEN" in response.body["setup"]["secrets"]


def test_usage_endpoint_renders_report() -> None:
    from usage import UsageReportBuilder

    report = UsageReportBuilder(days=2).build(
        [
            {
                "count": 4,
                "sum": {"totalNeurons": 12.0, "totalInputTokens": 40, "totalOutputTokens": 20},
                "dimensions": {
                    "date": __import__("datetime")
                    .datetime.now(__import__("datetime").UTC)
                    .date()
                    .isoformat(),
                    "modelId": "@cf/meta/x",
                },
            }
        ]
    )
    provider = FakeProvider()
    settings = Settings()
    adapter = HttpAdapter(
        settings,
        TranslationApp(settings, TranslationService(provider, chunker=TextChunker(1000)), logger),
        ChatApp(ChatService(provider, default_model=settings.model), logger),
        logger,
        usage_client_factory=lambda: FakeUsageClient(report),
    )

    response = call(
        adapter,
        FakeRequest(
            method="GET",
            url="https://x.dev/api/usage",
            headers=FakeHeaders({"authorization": "Bearer"}),
        ),
    )

    assert response.status == 200
    assert response.body["configured"] is True
    assert response.body["today"]["neurons"] == 12.0
    assert response.body["today"]["remaining"] == 9988.0
    assert response.body["models"][0]["label"] == "@cf/meta/x"


def test_usage_endpoint_surfaces_upstream_failure() -> None:
    from usage import UsageUnavailable

    provider = FakeProvider()
    settings = Settings()
    adapter = HttpAdapter(
        settings,
        TranslationApp(settings, TranslationService(provider, chunker=TextChunker(1000)), logger),
        ChatApp(ChatService(provider, default_model=settings.model), logger),
        logger,
        usage_client_factory=lambda: FakeUsageClient(error=UsageUnavailable("boom")),
    )

    response = call(
        adapter,
        FakeRequest(
            method="GET",
            url="https://x.dev/api/usage",
            headers=FakeHeaders({"authorization": "Bearer"}),
        ),
    )

    assert response.status == 502
    assert response.body["configured"] is True
    assert "boom" in response.body["message"]


def test_models_endpoint_lists_catalog() -> None:
    adapter, _ = make_adapter()
    response = call(
        adapter,
        FakeRequest(
            method="GET",
            url="https://x.dev/api/models",
            headers=FakeHeaders({"authorization": "Bearer"}),
        ),
    )

    assert response.status == 200
    assert response.body["default"] == Settings().model
    ids = [option["id"] for option in response.body["data"]]
    assert "@cf/zai-org/glm-4.7-flash" in ids
    assert all(model_id.startswith("@cf/") for model_id in ids)


def test_models_endpoint_requires_token() -> None:
    adapter, _ = make_adapter(api_token="secret")
    response = call(adapter, FakeRequest(method="GET", url="https://x.dev/api/models"))

    assert response.status == 401
