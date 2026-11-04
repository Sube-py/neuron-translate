from __future__ import annotations

from types import SimpleNamespace

from settings import DEFAULT_GATEWAY, DEFAULT_MODEL, Settings


class GetOnlyEnv:
    """Mimics a JavaScript env object that only exposes ``get``."""

    def __init__(self, values: dict[str, str]) -> None:
        self._values = values

    def get(self, name: str, default: object = None) -> object:
        return self._values.get(name, default)


def test_defaults_without_env() -> None:
    settings = Settings.from_env(None)

    assert settings.model == DEFAULT_MODEL
    assert settings.gateway_id == DEFAULT_GATEWAY
    assert settings.gateway_cache_ttl == 0
    assert settings.max_concurrency == 4
    assert settings.allowed_origins == ("*",)


def test_reads_vars_from_attribute_style_env() -> None:
    env = SimpleNamespace(
        TRANSLATION_MODEL="@cf/custom/model",
        AI_GATEWAY_ID="prod-gateway",
        AI_GATEWAY_CACHE_TTL="3600",
        TRANSLATION_CHUNK_CHARS="1200",
        TRANSLATION_MAX_CONCURRENCY="99",
        CORS_ALLOWED_ORIGINS="https://a.dev, https://b.dev",
        PLAYGROUND_ENABLED="false",
        TRANSLATION_API_TOKEN="s3cret",
    )

    settings = Settings.from_env(env)

    assert settings.model == "@cf/custom/model"
    assert settings.gateway_id == "prod-gateway"
    assert settings.gateway_cache_ttl == 3600
    assert settings.chunk_chars == 1200
    assert settings.max_concurrency == 8
    assert settings.allowed_origins == ("https://a.dev", "https://b.dev")
    assert settings.playground_enabled is False
    assert settings.api_token == "s3cret"


def test_reads_vars_from_get_style_env() -> None:
    settings = Settings.from_env(GetOnlyEnv({"AI_GATEWAY_ID": "gw-2"}))

    assert settings.gateway_id == "gw-2"


def test_invalid_values_fall_back_to_defaults() -> None:
    env = SimpleNamespace(
        AI_GATEWAY_CACHE_TTL="soon",
        TRANSLATION_TEMPERATURE="hot",
        TRANSLATION_MODEL="   ",
        TRANSLATION_API_TOKEN="undefined",
    )

    settings = Settings.from_env(env)

    assert settings.gateway_cache_ttl == 0
    assert settings.temperature == 0.1
    assert settings.model == DEFAULT_MODEL
    assert settings.api_token is None
