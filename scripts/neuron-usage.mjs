#!/usr/bin/env node
/**
 * Report Workers AI neuron usage against the 10,000/day free allowance.
 *
 * Credentials: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or reuse the local
 * `wrangler login` OAuth token.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.cloudflare.com/client/v4";
const FREE_NEURONS_PER_DAY = 10_000;
const NEURONS_PER_1K_PRICE_USD = 0.011;
const WRANGLER_CONFIG = join(homedir(), "Library/Preferences/.wrangler/config/default.toml");

const QUERY = `
query Usage($account: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      aiInferenceAdaptiveGroups(limit: 500, filter: { datetime_geq: $start, datetime_leq: $end }) {
        count
        sum { totalNeurons totalInputTokens totalOutputTokens }
        dimensions { modelId }
      }
    }
  }
}
`;

async function wranglerToken() {
  try {
    const text = await readFile(WRANGLER_CONFIG, "utf8");
    const line = text.split("\n").find((entry) => entry.startsWith("oauth_token"));
    return line ? line.split("=")[1]?.trim().replaceAll('"', "") ?? null : null;
  } catch {
    return null;
  }
}

async function resolveCredentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? (await wranglerToken());
  let account = process.env.CLOUDFLARE_ACCOUNT_ID ?? null;
  if (token && !account) {
    const response = await fetch(`${API}/accounts`, { headers: { authorization: `Bearer ${token}` } });
    const payload = await response.json();
    const accounts = payload.result ?? [];
    account = accounts.length === 1 ? accounts[0].id : null;
  }
  if (!token || !account) {
    throw new Error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or run `wrangler login` first.");
  }
  return { token, account };
}

async function fetchUsage({ token, account }, days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const response = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        account,
        start: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
        end: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    }),
  });
  const payload = await response.json();
  if (payload.errors) throw new Error(JSON.stringify(payload.errors));
  return payload.data.viewer.accounts[0].aiInferenceAdaptiveGroups ?? [];
}

function aggregate(rows) {
  const models = new Map();
  let neurons = 0;
  let requests = 0;
  for (const row of rows) {
    const entry = models.get(row.dimensions.modelId) ?? { requests: 0, neurons: 0 };
    entry.requests += row.count;
    entry.neurons += Number(row.sum.totalNeurons ?? 0);
    models.set(row.dimensions.modelId, entry);
    neurons += Number(row.sum.totalNeurons ?? 0);
    requests += row.count;
  }
  return {
    neurons,
    requests,
    percent: (neurons / FREE_NEURONS_PER_DAY) * 100,
    cost: (neurons / 1000) * NEURONS_PER_1K_PRICE_USD,
    models: [...models.entries()]
      .map(([label, value]) => ({ label, ...value }))
      .sort((left, right) => right.neurons - left.neurons),
  };
}

function render(report, label) {
  const lines = [
    label,
    `${"model".padEnd(50)} ${"req".padStart(6)} ${"neurons".padStart(10)}`,
  ];
  for (const model of report.models) {
    lines.push(`${model.label.slice(0, 50).padEnd(50)} ${String(model.requests).padStart(6)} ${model.neurons.toFixed(2).padStart(10)}`);
  }
  lines.push(
    `TOTAL ${String(report.requests).padStart(44)} ${report.neurons.toFixed(2).padStart(10)}`,
  );
  lines.push(
    `free quota ${report.neurons.toFixed(2)}/${FREE_NEURONS_PER_DAY} neurons (${report.percent.toFixed(2)}%), ` +
      `paid overage $${report.cost.toFixed(6)}`,
  );
  return lines.join("\n");
}

const daysArg = process.argv.find((arg) => arg.startsWith("--days="));
const days = Math.max(1, Math.min(Number(daysArg?.split("=")[1] ?? 1) || 1, 7));
const rows = await fetchUsage(await resolveCredentials(), days);
const report = aggregate(rows);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(render(report, `Workers AI usage · last ${days}d · ${new Date().toISOString()}`));
}
