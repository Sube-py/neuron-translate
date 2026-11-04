import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../src/domain/models.js";
import { upstreamError } from "../src/http/errors.js";
import { ModelCatalog } from "../src/provider/catalog.js";
import { parseCompletion, reasoningOf, shapeOf, textOf } from "../src/provider/response.js";
import { WorkersAiProvider, type ProviderOptions } from "../src/provider/workersAi.js";

class FakeBinding {
  calls: Array<{ model: string; inputs: Record<string, unknown>; options: Record<string, unknown> }> = [];

  constructor(private readonly response: unknown) {}

  async run(model: string, inputs: Record<string, unknown>, options: Record<string, unknown>) {
    this.calls.push({ model, inputs, options });
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "translate" },
  { role: "user", content: "Hello" },
];

const options: ProviderOptions = {
  gatewayId: "gw",
  temperature: 0.1,
  maxOutputTokens: 2048,
  cacheTtl: 0,
  collectLogs: true,
};

const makeProvider = (binding: FakeBinding, overrides: Partial<typeof options> = {}) =>
  new WorkersAiProvider(binding as never, "@cf/test/model", { ...options, ...overrides });

describe("response parsing", () => {
  it("reads the Workers AI response field", () => {
    expect(textOf({ response: " 你好 " })).toBe("你好");
  });

  it("reads OpenAI style choices with content parts", () => {
    expect(textOf({ choices: [{ message: { content: [{ type: "text", text: " hi " }] } }] })).toBe("hi");
  });

  it("reads the responses API output array", () => {
    expect(textOf({ output: [{ content: [{ text: " hola " }] }] })).toBe("hola");
  });

  it("parses usage, cache flag and reasoning", () => {
    const completion = parseCompletion({
      choices: [{ message: { content: "ok", reasoning: "thinking" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      cached: true,
    });

    expect(completion.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
    expect(completion.cached).toBe(true);
    expect(completion.reasoning).toBe("thinking");
    expect(reasoningOf({ choices: [{ message: { reasoning_content: "hmm" } }] })).toBe("hmm");
  });

  it("describes shapes without leaking content", () => {
    expect(shapeOf({ choices: [] })).toBe("{choices}");
    expect(shapeOf(null)).toBe("null");
  });
});

describe("WorkersAiProvider", () => {
  it("returns parsed text and usage", async () => {
    const binding = new FakeBinding({ response: " 你好 ", usage: { prompt_tokens: 3, completion_tokens: 2 } });
    const completion = await makeProvider(binding).complete(MESSAGES);

    expect(completion.text).toBe("你好");
    expect(completion.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
    const call = binding.calls[0]!;
    expect(call.model).toBe("@cf/test/model");
    expect(call.inputs).toMatchObject({ messages: MESSAGES, temperature: 0.1, max_tokens: 2048 });
    expect(call.options).toEqual({ gateway: { id: "gw", collectLog: true } });
  });

  it("attaches metadata and cache options", async () => {
    const binding = new FakeBinding({ response: "ok" });
    await makeProvider(binding, { cacheTtl: 3600 }).complete(MESSAGES, {
      metadata: { request_id: "r1", chunk: "1/1" },
      cacheKey: "hash",
    });

    const gateway = binding.calls[0]!.options.gateway as Record<string, unknown>;
    expect(gateway.cacheTtl).toBe(3600);
    expect(gateway.cacheKey).toBe("hash");
    expect(gateway.metadata).toEqual({ request_id: "r1", chunk: "1/1" });
  });

  it("omits cache options when disabled", async () => {
    const binding = new FakeBinding({ response: "ok" });
    await makeProvider(binding).complete(MESSAGES, { cacheKey: "hash" });
    const gateway = binding.calls[0]!.options.gateway as Record<string, unknown>;
    expect(gateway.cacheKey).toBeUndefined();
    expect(gateway.cacheTtl).toBeUndefined();
  });

  it("omits max_tokens when not configured", async () => {
    const binding = new FakeBinding({ response: "ok" });
    await makeProvider(binding, { maxOutputTokens: null }).complete(MESSAGES);
    expect(binding.calls[0]!.inputs.max_tokens).toBeUndefined();
  });

  it("allows a per-call max_tokens override", async () => {
    const binding = new FakeBinding({ response: "ok" });
    await makeProvider(binding).complete(MESSAGES, { maxTokens: 4096 });
    expect(binding.calls[0]!.inputs.max_tokens).toBe(4096);
  });

  it("maps binding failures to an upstream error", async () => {
    await expect(makeProvider(new FakeBinding(new Error("boom"))).complete(MESSAGES)).rejects.toThrow(
      /Workers AI call failed: boom/,
    );
  });

  it("reports a reasoning budget problem", async () => {
    const binding = new FakeBinding({ choices: [{ message: { content: null, reasoning: "thinking…" } }] });
    await expect(makeProvider(binding).complete(MESSAGES)).rejects.toMatchObject({
      code: "reasoning_budget_exhausted",
      status: 502,
    });
  });

  it("reports an empty response", async () => {
    await expect(makeProvider(new FakeBinding({ response: "  " })).complete(MESSAGES)).rejects.toMatchObject({
      code: "empty_response",
    });
  });

  it("falls back to a single chunk when the binding returns no stream", async () => {
    const binding = new FakeBinding({ response: "streamed" });
    const stream = await makeProvider(binding).stream(MESSAGES);
    const text = await new Response(stream).text();

    expect(binding.calls[0]!.inputs.stream).toBe(true);
    expect(text).toContain('"response":"streamed"');
  });
});

describe("ModelCatalog", () => {
  it("expands ids and resolves shorthands", () => {
    const catalog = new ModelCatalog("@cf/meta/llama-3.1-8b-instruct-fp8-fast");

    expect(catalog.ids().every((id) => id.startsWith("@cf/"))).toBe(true);
    expect(catalog.resolve("glm-4.7-flash")).toBe("@cf/zai-org/glm-4.7-flash");
    expect(catalog.resolve("meta/llama-3.1-8b-instruct-fp8-fast")).toBe(
      "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
    );
    expect(catalog.resolve("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(catalog.resolve("  ")).toBeNull();
  });

  it("always lists the deployed default model", () => {
    const catalog = new ModelCatalog("@cf/custom/model");
    expect(catalog.ids()[0]).toBe("@cf/custom/model");
    expect(catalog.list()[0]?.note).toBe("当前部署默认模型");
  });

  it("marks reasoning models", () => {
    const reasoning = new ModelCatalog("@cf/meta/x")
      .list()
      .filter((option) => option.reasoning)
      .map((option) => option.id);
    expect(reasoning).toContain("@cf/zai-org/glm-4.7-flash");
  });
});

describe("error helpers", () => {
  it("keeps the code and status", () => {
    const error = upstreamError("nope", "empty_response");
    expect(error.status).toBe(502);
    expect(error.code).toBe("empty_response");
  });
});
