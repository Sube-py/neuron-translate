#!/usr/bin/env python3
"""Report Workers AI neuron usage against the 10,000/day free allowance."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

API_BASE = "https://api.cloudflare.com/client/v4"
GRAPHQL_ENDPOINT = f"{API_BASE}/graphql"
WRANGLER_CONFIG = Path.home() / "Library/Preferences/.wrangler/config/default.toml"
FREE_NEURONS_PER_DAY = 10_000
NEURONS_PER_1K_PRICE_USD = 0.011

QUERY = """
query Usage($account: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      aiInferenceAdaptiveGroups(
        limit: 500
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        count
        sum { totalNeurons totalInputTokens totalOutputTokens }
        dimensions { modelId }
      }
    }
  }
}
"""


class CredentialsError(RuntimeError):
    """Raised when no usable Cloudflare credential is available."""


@dataclass(slots=True)
class Credentials:
    account_id: str
    token: str

    @classmethod
    def load(cls) -> Credentials:
        account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or os.environ.get("CF_ACCOUNT_ID")
        token = os.environ.get("CLOUDFLARE_API_TOKEN") or os.environ.get("CF_API_TOKEN")

        if not token:
            token = cls._from_wrangler_config()
        if token and not account_id:
            account_id = cls._account_from_api(token)

        if not token or not account_id:
            raise CredentialsError(
                "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or run `wrangler login` first."
            )
        return cls(account_id=account_id, token=token)

    @staticmethod
    def _from_wrangler_config() -> str | None:
        if not WRANGLER_CONFIG.is_file():
            return None
        for line in WRANGLER_CONFIG.read_text(encoding="utf-8").splitlines():
            if line.startswith("oauth_token"):
                return line.partition("=")[2].strip().strip('"') or None
        return None

    @staticmethod
    def _account_from_api(token: str) -> str | None:
        """Resolve the account id from the token when it is not configured."""
        request = urllib.request.Request(
            f"{API_BASE}/accounts", headers={"authorization": f"Bearer {token}"}
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError):
            return None

        accounts = payload.get("result") or []
        return accounts[0]["id"] if len(accounts) == 1 else None


@dataclass(slots=True)
class ModelUsage:
    model_id: str
    requests: int = 0
    neurons: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def cost_usd(self) -> float:
        return self.neurons / 1000 * NEURONS_PER_1K_PRICE_USD


@dataclass(slots=True)
class UsageReport:
    entries: list[ModelUsage] = field(default_factory=list)

    @classmethod
    def from_graphql(cls, rows: Iterable[dict]) -> UsageReport:
        entries = []
        for row in rows:
            totals = row.get("sum") or {}
            entries.append(
                ModelUsage(
                    model_id=(row.get("dimensions") or {}).get("modelId") or "unknown",
                    requests=int(row.get("count") or 0),
                    neurons=float(totals.get("totalNeurons") or 0),
                    input_tokens=int(totals.get("totalInputTokens") or 0),
                    output_tokens=int(totals.get("totalOutputTokens") or 0),
                )
            )
        entries.sort(key=lambda entry: entry.neurons, reverse=True)
        return cls(entries=entries)

    @property
    def total_neurons(self) -> float:
        return sum(entry.neurons for entry in self.entries)

    @property
    def total_requests(self) -> int:
        return sum(entry.requests for entry in self.entries)

    @property
    def quota_percent(self) -> float:
        return self.total_neurons / FREE_NEURONS_PER_DAY * 100

    def to_payload(self) -> dict:
        return {
            "total_neurons": round(self.total_neurons, 3),
            "total_requests": self.total_requests,
            "free_quota_percent": round(self.quota_percent, 3),
            "estimated_cost_usd": round(self.total_neurons / 1000 * NEURONS_PER_1K_PRICE_USD, 6),
            "models": [
                {
                    "model_id": entry.model_id,
                    "requests": entry.requests,
                    "neurons": round(entry.neurons, 3),
                    "input_tokens": entry.input_tokens,
                    "output_tokens": entry.output_tokens,
                }
                for entry in self.entries
            ],
        }

    def render(self, *, label: str) -> str:
        lines = [
            f"{label}",
            f"{'model':50} {'req':>6} {'neurons':>10} {'in_tok':>8} {'out_tok':>8}",
        ]
        for entry in self.entries:
            lines.append(
                f"{entry.model_id[:50]:50} {entry.requests:>6} {entry.neurons:>10.2f} "
                f"{entry.input_tokens:>8} {entry.output_tokens:>8}"
            )
        lines.append(f"{'TOTAL':50} {self.total_requests:>6} {self.total_neurons:>10.2f}")
        lines.append(
            f"free quota {self.total_neurons:.2f}/{FREE_NEURONS_PER_DAY} neurons "
            f"({self.quota_percent:.2f}%), paid overage "
            f"${self.total_neurons / 1000 * NEURONS_PER_1K_PRICE_USD:.6f}"
        )
        return "\n".join(lines)


class UsageClient:
    def __init__(self, credentials: Credentials, timeout: float = 30.0) -> None:
        self._credentials = credentials
        self._timeout = timeout

    def fetch(self, start: datetime, end: datetime) -> UsageReport:
        body = json.dumps(
            {
                "query": QUERY,
                "variables": {
                    "account": self._credentials.account_id,
                    "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
                },
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            GRAPHQL_ENDPOINT,
            data=body,
            method="POST",
            headers={
                "authorization": f"Bearer {self._credentials.token}",
                "content-type": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:  # pragma: no cover - network path
            raise RuntimeError(f"Cloudflare API error: {error.code}") from error

        if payload.get("errors"):
            raise RuntimeError(f"Cloudflare API error: {payload['errors']}")
        rows = payload["data"]["viewer"]["accounts"][0]["aiInferenceAdaptiveGroups"]
        return UsageReport.from_graphql(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=1, help="window size in days (1-7)")
    parser.add_argument("--json", action="store_true", help="print machine readable JSON")
    args = parser.parse_args(argv)

    end = datetime.now(UTC)
    start = end - timedelta(days=max(1, min(args.days, 7)))

    try:
        report = UsageClient(Credentials.load()).fetch(start, end)
    except (CredentialsError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report.to_payload(), ensure_ascii=False, indent=2))
    else:
        label = f"Workers AI usage {start:%Y-%m-%d %H:%M} → {end:%Y-%m-%d %H:%M} UTC"
        print(report.render(label=label))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
