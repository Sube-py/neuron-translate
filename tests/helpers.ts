import type { ChatMessage } from "../src/domain/models.js";
import type { Settings } from "../src/config/settings.js";
import type { Completion } from "../src/provider/response.js";

export interface ProviderCall {
  messages: ChatMessage[];
  model?: string | null;
  metadata?: Record<string, unknown>;
  maxTokens?: number | null;
}

export class FakeProvider {
  readonly gatewayId = "test-gateway";
  calls: ProviderCall[] = [];
  streamFrames: string[] = ['data: {"response":"你"}\n\n', 'data: {"response":"好"}\n\n', "data: [DONE]\n\n"];

  constructor(
    readonly model = "@cf/fake/model",
    private readonly behaviour: { prefix?: string; error?: Error; cached?: boolean } = {},
  ) {}

  async complete(
    messages: ChatMessage[],
    options: { model?: string | null; metadata?: Record<string, unknown>; maxTokens?: number | null } = {},
  ): Promise<Completion> {
    if (this.behaviour.error) throw this.behaviour.error;
    this.calls.push({
      messages,
      model: options.model,
      metadata: options.metadata,
      maxTokens: options.maxTokens,
    });
    const last = messages[messages.length - 1] as ChatMessage;
    return {
      text: `${this.behaviour.prefix ?? "T:"}${last.content}`,
      usage: { promptTokens: 10, completionTokens: 5 },
      cached: this.behaviour.cached ?? false,
      reasoning: "",
    };
  }

  async stream(messages: ChatMessage[], options: { model?: string | null } = {}) {
    this.calls.push({ messages, model: options.model });
    if (this.behaviour.error) throw this.behaviour.error;
    const encoder = new TextEncoder();
    const frames = this.streamFrames;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    return body;
  }
}

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    model: "@cf/fake/model",
    gatewayId: "test-gateway",
    gatewayCacheTtl: 0,
    gatewayCollectLogs: true,
    temperature: 0.1,
    maxOutputTokens: 2048,
    chunkChars: 1000,
    maxTextChars: 20000,
    maxConcurrency: 4,
    apiToken: null,
    allowedOrigins: ["*"],
    analyticsAccountId: null,
    analyticsToken: null,
    usageDays: 7,
    usageConfigured: false,
    ...overrides,
  };
}
