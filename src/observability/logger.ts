/** One JSON object per log line, so `wrangler tail` stays parseable. */

export interface LogFields {
  [key: string]: unknown;
}

export class Logger {
  constructor(
    private readonly service = "trans",
    private readonly enabled = true,
  ) {}

  info(event: string, fields: LogFields = {}): void {
    this.emit("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.emit("warning", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.emit("error", event, fields);
  }

  private emit(level: string, event: string, fields: LogFields): void {
    if (!this.enabled) return;
    const record = {
      service: this.service,
      level,
      event,
      ts: Math.round(Date.now()) / 1000,
      ...fields,
    };
    try {
      console.log(JSON.stringify(record));
    } catch {
      console.log(JSON.stringify({ service: this.service, event }));
    }
  }
}
