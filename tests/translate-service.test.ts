import { describe, expect, it } from "vitest";

import type { ChatMessage, TranslationRequest } from "../src/domain/models.js";
import type { Completion } from "../src/provider/response.js";
import type { WorkersAiProvider } from "../src/provider/workersAi.js";
import { TextChunker } from "../src/translate/chunker.js";
import { TranslationService, cacheKey, mapWithConcurrency } from "../src/translate/service.js";

class FakeProvider {
  readonly model: string;
  readonly gatewayId = "test-gateway";
  calls: Array<{ messages: ChatMessage[]; model?: string | null; metadata: Record<string, unknown> }> = [];

  constructor(
    model = "@cf/fake/model",
    private readonly behaviour: { prefix?: string; error?: Error; cached?: boolean } = {},
  ) {
    this.model = model;
  }

  async complete(
    messages: ChatMessage[],
    options: { model?: string | null; metadata?: Record<string, unknown> } = {},
  ): Promise<Completion> {
    if (this.behaviour.error) throw this.behaviour.error;
    this.calls.push({
      messages,
      model: options.model,
      metadata: options.metadata ?? {},
    });
    const last = messages[messages.length - 1] as ChatMessage;
    return {
      text: `${this.behaviour.prefix ?? "T:"}${last.content}`,
      usage: { promptTokens: 10, completionTokens: 5 },
      cached: this.behaviour.cached ?? false,
      reasoning: "",
    };
  }
}

const makeService = (provider: FakeProvider, chunkChars = 1000, concurrency = 4) =>
  new TranslationService(provider as unknown as WorkersAiProvider, new TextChunker(chunkChars), {
    maxConcurrency: concurrency,
  });

const request = (overrides: Partial<TranslationRequest> = {}): TranslationRequest => ({
  text: "Hello",
  targetLang: "zh",
  sourceLang: "auto",
  tone: null,
  glossary: {},
  preserveFormatting: true,
  model: null,
  ...overrides,
});

describe("TranslationService", () => {
  it("translates a single chunk", async () => {
    const result = await makeService(new FakeProvider()).translate(request(), "r1");

    expect(result.text).toBe("T:Hello");
    expect(result.chunkCount).toBe(1);
    expect(result.model).toBe("@cf/fake/model");
    expect(result.gatewayId).toBe("test-gateway");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it("reassembles chunks and sends gateway metadata", async () => {
    const provider = new FakeProvider();
    const text = "A".repeat(90) + "\n\n" + "B".repeat(90);
    const result = await makeService(provider, 100).translate(
      request({ text, targetLang: "ja", sourceLang: "en" }),
      "req-42",
    );

    expect(result.text).toBe(`T:${"A".repeat(90)}\n\nT:${"B".repeat(90)}`);
    expect(result.chunkCount).toBe(2);
    expect(result.usage.promptTokens).toBe(20);
    expect(provider.calls.map((call) => call.metadata.chunk)).toEqual(["1/2", "2/2"]);
    expect(provider.calls[0]?.metadata).toEqual({
      request_id: "req-42",
      target_lang: "ja",
      source_lang: "en",
      chunk: "1/2",
      chars: 90,
    });
  });

  it("honours a per-request model override", async () => {
    const provider = new FakeProvider();
    const result = await makeService(provider).translate(
      request({ model: "@cf/zai-org/glm-4.7-flash" }),
      "r-model",
    );

    expect(result.model).toBe("@cf/zai-org/glm-4.7-flash");
    expect(provider.calls[0]?.model).toBe("@cf/zai-org/glm-4.7-flash");
  });

  it("counts cached chunks", async () => {
    const result = await makeService(new FakeProvider("@cf/x", { cached: true })).translate(
      request({ targetLang: "de" }),
      "r",
    );
    expect(result.cachedChunks).toBe(1);
  });

  it("wraps provider failures", async () => {
    const provider = new FakeProvider("@cf/x", { error: new Error("boom") });
    await expect(makeService(provider).translate(request(), "r")).rejects.toThrow(/chunk 0 failed|boom/);
  });
});

describe("cacheKey", () => {
  it("is stable and content sensitive", async () => {
    const first = await cacheKey("m", "system", "Hello", "zh");
    const second = await cacheKey("m", "system", "Hello", "zh");
    const third = await cacheKey("m", "system", "Hello", "fr");

    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order while limiting concurrency", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
