"""Runtime configuration derived from Worker environment variables."""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
DEFAULT_GATEWAY = "default"
_EMPTY_VALUES = {"", "undefined", "null", "none"}


def _read(env: object, name: str) -> str | None:
    """Read a binding or var from the Worker ``env`` object."""
    if env is None:
        return None

    value = None
    try:
        value = getattr(env, name)
    except Exception:
        value = None

    if value is None:
        getter = getattr(env, "get", None)
        if callable(getter):
            try:
                value = getter(name)
            except Exception:
                value = None

    if value is None:
        return None

    text = str(value).strip()
    return None if text.lower() in _EMPTY_VALUES else text


def _as_int(
    env: object,
    name: str,
    default: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    raw = _read(env, name)
    if raw is None:
        return default
    try:
        value = int(float(raw))
    except ValueError:
        return default
    if minimum is not None:
        value = max(value, minimum)
    if maximum is not None:
        value = min(value, maximum)
    return value


def _as_float(
    env: object,
    name: str,
    default: float,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    raw = _read(env, name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    if minimum is not None:
        value = max(value, minimum)
    if maximum is not None:
        value = min(value, maximum)
    return value


def _as_bool(env: object, name: str, default: bool) -> bool:
    raw = _read(env, name)
    if raw is None:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def _as_csv(env: object, name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = _read(env, name)
    if raw is None:
        return default
    values = tuple(item.strip() for item in raw.split(",") if item.strip())
    return values or default


@dataclass(frozen=True, slots=True)
class Settings:
    """Immutable per-request view of the Worker configuration."""

    model: str = DEFAULT_MODEL
    gateway_id: str = DEFAULT_GATEWAY
    gateway_cache_ttl: int = 0
    gateway_collect_logs: bool = True
    temperature: float = 0.1
    max_output_tokens: int = 2048
    chunk_chars: int = 3000
    max_text_chars: int = 20000
    max_concurrency: int = 4
    api_token: str | None = None
    allowed_origins: tuple[str, ...] = ("*",)
    playground_enabled: bool = True

    @classmethod
    def from_env(cls, env: object) -> Settings:
        return cls(
            model=_read(env, "TRANSLATION_MODEL") or DEFAULT_MODEL,
            gateway_id=_read(env, "AI_GATEWAY_ID") or DEFAULT_GATEWAY,
            gateway_cache_ttl=_as_int(env, "AI_GATEWAY_CACHE_TTL", 0, minimum=0),
            gateway_collect_logs=_as_bool(env, "AI_GATEWAY_COLLECT_LOGS", True),
            temperature=_as_float(env, "TRANSLATION_TEMPERATURE", 0.1, minimum=0.0, maximum=2.0),
            max_output_tokens=_as_int(env, "TRANSLATION_MAX_OUTPUT_TOKENS", 2048, minimum=64),
            chunk_chars=_as_int(env, "TRANSLATION_CHUNK_CHARS", 3000, minimum=500, maximum=20000),
            max_text_chars=_as_int(env, "TRANSLATION_MAX_TEXT_CHARS", 20000, minimum=500),
            max_concurrency=_as_int(env, "TRANSLATION_MAX_CONCURRENCY", 4, minimum=1, maximum=8),
            api_token=_read(env, "TRANSLATION_API_TOKEN"),
            allowed_origins=_as_csv(env, "CORS_ALLOWED_ORIGINS", ("*",)),
            playground_enabled=_as_bool(env, "PLAYGROUND_ENABLED", True),
        )
