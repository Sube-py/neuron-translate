from __future__ import annotations

from model_catalog import CATALOG, ModelCatalog


def test_catalog_ids_are_expanded() -> None:
    catalog = ModelCatalog("@cf/meta/llama-3.1-8b-instruct-fp8-fast")
    ids = catalog.ids()

    assert all(model_id.startswith("@cf/") for model_id in ids)
    assert "@cf/zai-org/glm-4.7-flash" in ids
    assert len(ids) == len(CATALOG)


def test_default_model_is_always_present() -> None:
    catalog = ModelCatalog("@cf/custom/model")

    assert catalog.ids()[0] == "@cf/custom/model"
    assert catalog.options()[0]["note"] == "当前部署默认模型"


def test_resolve_accepts_shorthand_and_full_ids() -> None:
    catalog = ModelCatalog("@cf/meta/llama-3.1-8b-instruct-fp8-fast")

    assert catalog.resolve("glm-4.7-flash") == "@cf/zai-org/glm-4.7-flash"
    assert catalog.resolve("@cf/zai-org/glm-4.7-flash") == "@cf/zai-org/glm-4.7-flash"
    assert catalog.resolve("  ") is None
    assert catalog.resolve(None) is None


def test_resolve_passes_through_unknown_ids() -> None:
    catalog = ModelCatalog("@cf/meta/llama-3.1-8b-instruct-fp8-fast")

    assert catalog.resolve("@cf/meta/unknown-model") == "@cf/meta/unknown-model"
    assert catalog.resolve("gpt-4o-mini") == "gpt-4o-mini"


def test_payload_marks_reasoning_models() -> None:
    options = ModelCatalog("@cf/meta/x").options()
    reasoning = {option["id"] for option in options if option["reasoning"]}

    assert "@cf/zai-org/glm-4.7-flash" in reasoning
    assert "@cf/meta/llama-3.1-8b-instruct-fp8-fast" not in reasoning
