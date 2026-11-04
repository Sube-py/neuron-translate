/** Neuron usage aggregation and shaping for the dashboard. */

export const FREE_NEURONS_PER_DAY = 10_000;
export const NEURONS_PER_1K_PRICE_USD = 0.011;
export const MAX_DAYS = 7;

export interface UsageBucket {
  label: string;
  neurons: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageRow {
  count: number;
  sum: {
    totalNeurons: number | null;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
  };
  dimensions: { date: string | null; modelId: string | null };
}

function emptyBucket(label: string): UsageBucket {
  return { label, neurons: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
}

function add(bucket: UsageBucket, row: UsageRow): void {
  bucket.neurons += Number(row.sum.totalNeurons ?? 0);
  bucket.requests += Number(row.count ?? 0);
  bucket.inputTokens += Number(row.sum.totalInputTokens ?? 0);
  bucket.outputTokens += Number(row.sum.totalOutputTokens ?? 0);
}

function bucketPayload(bucket: UsageBucket): Record<string, number | string> {
  return {
    label: bucket.label,
    neurons: round(bucket.neurons, 3),
    requests: bucket.requests,
    input_tokens: bucket.inputTokens,
    output_tokens: bucket.outputTokens,
    cost_usd: round((bucket.neurons / 1000) * NEURONS_PER_1K_PRICE_USD, 6),
  };
}

export class UsageReport {
  constructor(
    readonly days: UsageBucket[],
    readonly models: UsageBucket[],
  ) {}

  get today(): UsageBucket {
    return this.days[this.days.length - 1] ?? emptyBucket("");
  }

  toPayload(): Record<string, unknown> {
    const used = this.today.neurons;
    return {
      free_neurons_per_day: FREE_NEURONS_PER_DAY,
      neurons_per_1k_price_usd: NEURONS_PER_1K_PRICE_USD,
      today: {
        ...bucketPayload(this.today),
        percent: round((used / FREE_NEURONS_PER_DAY) * 100, 2),
        remaining: round(Math.max(FREE_NEURONS_PER_DAY - used, 0), 3),
      },
      days: this.days.map(bucketPayload),
      models: this.models.map(bucketPayload),
      window_neurons: round(
        this.days.reduce((total, bucket) => total + bucket.neurons, 0),
        3,
      ),
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  }
}

export class UsageReportBuilder {
  private readonly dayCount: number;

  constructor(
    days: number,
    private readonly now: Date = new Date(),
  ) {
    this.dayCount = Math.max(1, Math.min(days, MAX_DAYS));
  }

  dateRange(): string[] {
    const today = Date.UTC(this.now.getUTCFullYear(), this.now.getUTCMonth(), this.now.getUTCDate());
    const dates: string[] = [];
    for (let offset = this.dayCount - 1; offset >= 0; offset -= 1) {
      dates.push(new Date(today - offset * 86_400_000).toISOString().slice(0, 10));
    }
    return dates;
  }

  windowStart(): Date {
    const start = new Date(
      Date.UTC(this.now.getUTCFullYear(), this.now.getUTCMonth(), this.now.getUTCDate()),
    );
    return new Date(start.getTime() - (this.dayCount - 1) * 86_400_000);
  }

  build(rows: UsageRow[]): UsageReport {
    const dates = this.dateRange();
    const byDate = new Map<string, UsageBucket>(dates.map((date) => [date, emptyBucket(date)]));
    const byModel = new Map<string, UsageBucket>();

    for (const row of rows) {
      const date = (row.dimensions.date ?? "").slice(0, 10);
      const modelId = row.dimensions.modelId ?? "unknown";
      const dateBucket = byDate.get(date) ?? emptyBucket(date);
      byDate.set(date, dateBucket);
      add(dateBucket, row);

      const modelBucket = byModel.get(modelId) ?? emptyBucket(modelId);
      byModel.set(modelId, modelBucket);
      add(modelBucket, row);
    }

    const days = dates.map((date) => byDate.get(date) ?? emptyBucket(date));
    const models = [...byModel.values()].sort((left, right) => right.neurons - left.neurons);
    return new UsageReport(days, models);
  }
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
