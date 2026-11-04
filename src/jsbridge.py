"""Bridge helpers for values crossing the Python/JavaScript boundary."""

from __future__ import annotations

from typing import Any


def to_js(value: Any) -> Any:
    """Convert Python containers into real JavaScript objects.

    Outside the Workers runtime (for example in unit tests) the value is
    returned unchanged.
    """
    try:
        from js import Object
        from pyodide.ffi import to_js as _to_js
    except ImportError:
        return value
    return _to_js(value, dict_converter=Object.fromEntries)


def to_py(value: Any) -> Any:
    """Best-effort conversion of a JavaScript value into plain Python data."""
    if value is None or isinstance(value, (str, int, float, bool, dict, list, tuple)):
        return value
    converter = getattr(value, "to_py", None)
    if callable(converter):
        try:
            return converter()
        except Exception:
            return value
    return value
