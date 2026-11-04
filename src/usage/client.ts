/** Reads Workers AI neuron usage from the Cloudflare GraphQL Analytics API. */

import { UsageReport, UsageReportBuilder, type UsageRow } from "./report.js";

export const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

const USAGE_QUERY = `
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
`;

export class UsageUnavailable extends Error {}

export type GraphQlFetcher = (
  query: string,
  variables: Record<string, unknown>,
  token: string,
) => Promise<unknown>;

export interface UsageClientOptions {
  accountId: string;
  token: string;
  days?: number;
  fetcher?: GraphQlFetcher;
}

export class UsageClient {
  private readonly builder: UsageReportBuilder;
  private readonly fetcher: GraphQlFetcher;

  constructor(private readonly options: UsageClientOptions) {
    this.builder = new UsageReportBuilder(options.days ?? 7);
    this.fetcher = options.fetcher ?? defaultFetcher;
  }

  async fetch(): Promise<UsageReport> {
    const variables = {
      account: this.options.accountId,
      start: this.builder.windowStart().toISOString().replace(/\.\d{3}Z$/, "Z"),
      end: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };

    let payload: unknown;
    try {
      payload = await this.fetcher(USAGE_QUERY, variables, this.options.token);
    } catch (error) {
      throw new UsageUnavailable(`Analytics request failed: ${String(error)}`);
    }

    const body = payload as {
      errors?: Array<{ message?: string }>;
      data?: { viewer?: { accounts?: Array<{ aiInferenceAdaptiveGroups?: UsageRow[] }> } };
    };

    if (body.errors && body.errors.length > 0) {
      throw new UsageUnavailable(`Analytics error: ${body.errors[0]?.message ?? "unknown"}`);
    }

    const account = body.data?.viewer?.accounts?.[0];
    if (!account) {
      throw new UsageUnavailable("Analytics returned no account data; check ANALYTICS_ACCOUNT_ID.");
    }
    return this.builder.build(account.aiInferenceAdaptiveGroups ?? []);
  }
}

const defaultFetcher: GraphQlFetcher = async (query, variables, token) => {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
};

export class MissingUsageConfiguration {
  static readonly setup = {
    secrets: ["ANALYTICS_ACCOUNT_ID", "ANALYTICS_API_TOKEN"],
    permission: "Account → Account Analytics → Read",
    commands: [
      "printf '%s' <account_id> | npx wrangler secret put ANALYTICS_ACCOUNT_ID --name trans",
      "printf '%s' <api_token>  | npx wrangler secret put ANALYTICS_API_TOKEN --name trans",
    ],
  };

  async fetch(): Promise<UsageReport> {
    throw new UsageUnavailable("Usage analytics is not configured.");
  }
}
