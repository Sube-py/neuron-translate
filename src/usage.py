"""Workers AI neuron usage pulled from the Cloudflare GraphQL Analytics API."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

from jsbridge import to_py

GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql"
FREE_NEURONS_PER_DAY = 10_000
NEURONS_PER_1K_PRICE_USD = 0.011
MAX_DAYS = 7

USAGE_QUERY = """
query NeuronUsage($account: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      aiInferenceAdaptiveGroups(
        limit: 1000
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        count
        sum { totalNeurons totalInputTokens totalOutputTokens }
        dimensions { date modelId }
      }
    }
  }
}
"""


class UsageUnavailable(RuntimeError):
    """Raised when usage data cannot be fetched or is not configured."""


@dataclass(slots=True)
class UsageBucket:
    label: str
    neurons: float = 0.0
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0

    def add(self, *, neurons: float, requests: int, input_tokens: int, output_tokens: int) -> None:
        self.neurons += neurons
        self.requests += requests
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens

    def to_payload(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "neurons": round(self.neurons, 3),
            "requests": self.requests,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": round(self.neurons / 1000 * NEURONS_PER_1K_PRICE_USD, 6),
        }


@dataclass(slots=True)
class UsageReport:
    days: list[UsageBucket] = field(default_factory=list)
    models: list[UsageBucket] = field(default_factory=list)

    @property
    def today(self) -> UsageBucket:
        return self.days[-1] if self.days else UsageBucket(label="")

    def to_payload(self) -> dict[str, Any]:
        used = self.today.neurons
        return {
            "free_neurons_per_day": FREE_NEURONS_PER_DAY,
            "neurons_per_1k_price_usd": NEURONS_PER_1K_PRICE_USD,
            "today": {
                **self.today.to_payload(),
                "percent": round(used / FREE_NEURONS_PER_DAY * 100, 2),
                "remaining": round(max(FREE_NEURONS_PER_DAY - used, 0), 3),
            },
            "days": [bucket.to_payload() for bucket in self.days],
            "models": [bucket.to_payload() for bucket in self.models],
            "window_neurons": round(sum(bucket.neurons for bucket in self.days), 3),
            "generated_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }


class UsageReportBuilder:
    """Turns raw GraphQL rows into a per-day and per-model report."""

    def __init__(self, days: int, *, now: datetime | None = None) -> None:
        self._days = max(1, min(days, MAX_DAYS))
        self._now = now or datetime.now(UTC)

    def build(self, rows: list[dict[str, Any]]) -> UsageReport:
        dates = self._date_range()
        by_date = {date: UsageBucket(label=date) for date in dates}
        by_model: dict[str, UsageBucket] = {}

        for row in rows:
            totals = row.get("sum") or {}
            dimensions = row.get("dimensions") or {}
            datetime_value = str(dimensions.get("date") or "")[:10]
            model_id = str(dimensions.get("modelId") or "unknown")
            values = {
                "neurons": float(totals.get("totalNeurons") or 0),
                "requests": int(row.get("count") or 0),
                "input_tokens": int(totals.get("totalInputTokens") or 0),
                "output_tokens": int(totals.get("totalOutputTokens") or 0),
            }
            by_date.setdefault(datetime_value, UsageBucket(label=datetime_value)).add(**values)
            by_model.setdefault(model_id, UsageBucket(label=model_id)).add(**values)

        days = [by_date[date] for date in dates]
        models = sorted(by_model.values(), key=lambda bucket: bucket.neurons, reverse=True)
        return UsageReport(days=days, models=models)

    def _date_range(self) -> list[str]:
        today = self._now.date()
        return [
            (today - timedelta(days=offset)).isoformat() for offset in range(self._days - 1, -1, -1)
        ]

    def window_start(self) -> datetime:
        start = (self._now - timedelta(days=self._days - 1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        return start


FetchJson = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


class UsageClient:
    """Reads neuron usage for the current account from the analytics API."""

    def __init__(
        self,
        account_id: str,
        token: str,
        *,
        days: int = 7,
        fetch_json: FetchJson | None = None,
    ) -> None:
        self._account_id = account_id
        self._token = token
        self._builder = UsageReportBuilder(days)
        self._fetch_json = fetch_json or self._default_fetch_json

    async def fetch(self) -> UsageReport:
        variables = {
            "account": self._account_id,
            "start": self._builder.window_start().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        try:
            payload = await self._fetch_json(
                GRAPHQL_ENDPOINT,
                {
                    "query": USAGE_QUERY,
                    "variables": variables,
                    "authorization": f"Bearer {self._token}",
                },
            )
        except Exception as exc:
            raise UsageUnavailable(f"Analytics request failed: {exc}") from exc

        if payload.get("errors"):
            message = payload["errors"][0].get("message", "unknown analytics error")
            raise UsageUnavailable(f"Analytics error: {message}")

        accounts = ((payload.get("data") or {}).get("viewer") or {}).get("accounts") or []
        if not accounts:
            raise UsageUnavailable(
                "Analytics returned no account data; check ANALYTICS_ACCOUNT_ID."
            )
        return self._builder.build(accounts[0].get("aiInferenceAdaptiveGroups") or [])

    @staticmethod
    async def _default_fetch_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
        from workers import fetch

        response = await fetch(
            url,
            method="POST",
            headers={
                "authorization": payload["authorization"],
                "content-type": "application/json",
            },
            body=json.dumps({"query": payload["query"], "variables": payload["variables"]}),
        )
        data = to_py(await response.json())
        if isinstance(data, str):
            return json.loads(data)
        if isinstance(data, dict):
            return data
        raise UsageUnavailable("Analytics returned an unexpected payload.")


class MissingUsageConfiguration:
    """Stand-in client used when the analytics secrets are not configured."""

    setup: ClassVar[dict[str, Any]] = {
        "secrets": ["ANALYTICS_ACCOUNT_ID", "ANALYTICS_API_TOKEN"],
        "permission": "Account → Account Analytics → Read",
        "commands": [
            "printf '%s' <account_id> | npx wrangler secret put ANALYTICS_ACCOUNT_ID",
            "printf '%s' <api_token> | npx wrangler secret put ANALYTICS_API_TOKEN",
        ],
    }

    async def fetch(self) -> UsageReport:
        raise UsageUnavailable("Usage analytics is not configured.")
