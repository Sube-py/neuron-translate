from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest

from usage import (
    FREE_NEURONS_PER_DAY,
    MissingUsageConfiguration,
    UsageClient,
    UsageReportBuilder,
    UsageUnavailable,
)

NOW = datetime(2026, 11, 4, 12, 0, 0, tzinfo=UTC)


def row(date: str, model: str, neurons: float, count: int = 1) -> dict:
    return {
        "count": count,
        "sum": {
            "totalNeurons": neurons,
            "totalInputTokens": 100,
            "totalOutputTokens": 40,
        },
        "dimensions": {"date": date, "modelId": model},
    }


def test_builder_fills_missing_days_and_aggregates_models() -> None:
    report = UsageReportBuilder(3, now=NOW).build(
        [
            row("2026-11-02", "@cf/meta/small", 1.5, count=2),
            row("2026-11-04", "@cf/meta/big", 10.0, count=3),
            row("2026-11-04", "@cf/meta/small", 2.0, count=1),
        ]
    )

    assert [bucket.label for bucket in report.days] == ["2026-11-02", "2026-11-03", "2026-11-04"]
    assert [bucket.neurons for bucket in report.days] == [1.5, 0.0, 12.0]
    assert report.today.neurons == 12.0
    assert report.today.requests == 4
    assert [bucket.label for bucket in report.models] == ["@cf/meta/big", "@cf/meta/small"]


def test_payload_reports_remaining_and_percent() -> None:
    report = UsageReportBuilder(1, now=NOW).build([row("2026-11-04", "@cf/meta/x", 250.0)])
    payload = report.to_payload()

    assert payload["today"]["percent"] == 2.5
    assert payload["today"]["remaining"] == FREE_NEURONS_PER_DAY - 250.0
    assert payload["free_neurons_per_day"] == FREE_NEURONS_PER_DAY
    assert payload["window_neurons"] == 250.0
    assert payload["days"][0]["cost_usd"] > 0


def test_payload_never_reports_negative_remaining() -> None:
    report = UsageReportBuilder(1, now=NOW).build([row("2026-11-04", "@cf/meta/x", 20_000.0)])
    payload = report.to_payload()

    assert payload["today"]["remaining"] == 0
    assert payload["today"]["percent"] == 200.0


def test_builder_clamps_window() -> None:
    builder = UsageReportBuilder(99, now=NOW)
    report = builder.build([])

    assert len(report.days) == 7
    assert builder.window_start() == datetime(2026, 10, 29, 0, 0, tzinfo=UTC)


def test_client_queries_graphql_with_token() -> None:
    captured: dict[str, object] = {}

    async def fake_fetch(url: str, payload: dict) -> dict:
        captured["url"] = url
        captured["payload"] = payload
        return {
            "data": {
                "viewer": {
                    "accounts": [
                        {"aiInferenceAdaptiveGroups": [row("2026-11-04", "@cf/meta/x", 5.0)]}
                    ]
                }
            }
        }

    client = UsageClient("acc", "tok", days=1, fetch_json=fake_fetch)
    report = asyncio.run(client.fetch())

    assert report.today.neurons == 5.0
    assert captured["url"].endswith("/graphql")
    assert captured["payload"]["authorization"] == "Bearer tok"
    assert captured["payload"]["variables"]["account"] == "acc"


def test_client_surfaces_graphql_errors() -> None:
    async def fake_fetch(url: str, payload: dict) -> dict:
        return {"errors": [{"message": "nope"}]}

    client = UsageClient("acc", "tok", fetch_json=fake_fetch)

    with pytest.raises(UsageUnavailable) as error:
        asyncio.run(client.fetch())
    assert "nope" in str(error.value)


def test_client_surfaces_transport_failures() -> None:
    async def fake_fetch(url: str, payload: dict) -> dict:
        raise OSError("connection lost")

    client = UsageClient("acc", "tok", fetch_json=fake_fetch)

    with pytest.raises(UsageUnavailable):
        asyncio.run(client.fetch())


def test_missing_configuration_raises() -> None:
    with pytest.raises(UsageUnavailable):
        asyncio.run(MissingUsageConfiguration().fetch())
