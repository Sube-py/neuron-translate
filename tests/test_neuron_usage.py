from __future__ import annotations

from neuron_usage import FREE_NEURONS_PER_DAY, UsageReport

ROWS = [
    {
        "count": 3,
        "sum": {"totalNeurons": 30.0, "totalInputTokens": 100, "totalOutputTokens": 50},
        "dimensions": {"modelId": "@cf/meta/big"},
    },
    {
        "count": 1,
        "sum": {"totalNeurons": 10.0, "totalInputTokens": 20, "totalOutputTokens": 10},
        "dimensions": {"modelId": "@cf/meta/small"},
    },
    {"count": 2, "sum": {}, "dimensions": {}},
]


def test_report_totals_and_ordering() -> None:
    report = UsageReport.from_graphql(ROWS)

    assert [entry.model_id for entry in report.entries] == [
        "@cf/meta/big",
        "@cf/meta/small",
        "unknown",
    ]
    assert report.total_requests == 6
    assert report.total_neurons == 40.0
    assert round(report.quota_percent, 3) == round(40 / FREE_NEURONS_PER_DAY * 100, 3)


def test_report_payload_and_render() -> None:
    report = UsageReport.from_graphql(ROWS)
    payload = report.to_payload()

    assert payload["total_neurons"] == 40.0
    assert payload["estimated_cost_usd"] == 0.00044

    text = report.render(label="window")
    assert "window" in text
    assert "free quota 40.00/10000" in text


def test_empty_report_is_safe() -> None:
    report = UsageReport.from_graphql([])

    assert report.total_neurons == 0
    assert report.total_requests == 0
    assert "free quota 0.00" in report.render(label="empty")
