import { describe, expect, it } from "vitest";

import { FREE_NEURONS_PER_DAY, UsageReportBuilder } from "../src/usage/report.js";
import { MissingUsageConfiguration, UsageClient, UsageUnavailable } from "../src/usage/client.js";

const NOW = new Date("2026-11-04T12:00:00Z");

const row = (date: string, model: string, neurons: number, count = 1) => ({
  count,
  sum: { totalNeurons: neurons, totalInputTokens: 100, totalOutputTokens: 40 },
  dimensions: { date, modelId: model },
});

describe("UsageReportBuilder", () => {
  it("fills missing days and aggregates models", () => {
    const report = new UsageReportBuilder(3, NOW).build([
      row("2026-11-02", "@cf/meta/small", 1.5, 2),
      row("2026-11-04", "@cf/meta/big", 10, 3),
      row("2026-11-04", "@cf/meta/small", 2, 1),
    ]);

    expect(report.days.map((day) => day.label)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(report.days.map((day) => day.neurons)).toEqual([1.5, 0, 12]);
    expect(report.today.requests).toBe(4);
    expect(report.models.map((model) => model.label)).toEqual(["@cf/meta/big", "@cf/meta/small"]);
  });

  it("reports remaining and percent", () => {
    const payload = new UsageReportBuilder(1, NOW).build([row("2026-11-04", "@cf/meta/x", 250)]).toPayload();
    const today = payload.today as Record<string, number>;

    expect(today.percent).toBe(2.5);
    expect(today.remaining).toBe(FREE_NEURONS_PER_DAY - 250);
    expect(payload.window_neurons).toBe(250);
  });

  it("never reports a negative remaining", () => {
    const payload = new UsageReportBuilder(1, NOW).build([row("2026-11-04", "@cf/meta/x", 20_000)]).toPayload();
    expect((payload.today as Record<string, number>).remaining).toBe(0);
    expect((payload.today as Record<string, number>).percent).toBe(200);
  });

  it("clamps the window to seven days", () => {
    const builder = new UsageReportBuilder(99, NOW);
    expect(builder.build([]).days).toHaveLength(7);
    expect(builder.windowStart().toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });
});

describe("UsageClient", () => {
  it("queries GraphQL with the token", async () => {
    const captured: { query?: string; variables?: Record<string, unknown>; token?: string } = {};
    const client = new UsageClient({
      accountId: "acc",
      token: "tok",
      days: 1,
      fetcher: async (query, variables, token) => {
        captured.query = query;
        captured.variables = variables;
        captured.token = token;
        return { data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [row("2026-11-04", "@cf/meta/x", 5)] }] } } };
      },
    });

    const report = await client.fetch();
    expect(report.today.neurons).toBe(5);
    expect(captured.token).toBe("tok");
    expect(captured.variables?.account).toBe("acc");
  });

  it("surfaces GraphQL errors", async () => {
    const client = new UsageClient({
      accountId: "acc",
      token: "tok",
      fetcher: async () => ({ errors: [{ message: "nope" }] }),
    });
    await expect(client.fetch()).rejects.toThrow(/nope/);
  });

  it("surfaces transport failures", async () => {
    const client = new UsageClient({
      accountId: "acc",
      token: "tok",
      fetcher: async () => {
        throw new Error("connection lost");
      },
    });
    await expect(client.fetch()).rejects.toBeInstanceOf(UsageUnavailable);
  });

  it("fails when the account is missing", async () => {
    const client = new UsageClient({ accountId: "acc", token: "tok", fetcher: async () => ({ data: {} }) });
    await expect(client.fetch()).rejects.toThrow(/ANALYTICS_ACCOUNT_ID/);
  });

  it("raises when analytics is not configured", async () => {
    await expect(new MissingUsageConfiguration().fetch()).rejects.toBeInstanceOf(UsageUnavailable);
  });
});
