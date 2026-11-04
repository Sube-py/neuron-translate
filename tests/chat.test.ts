import { describe, expect, it } from "vitest";

import { ChatService } from "../src/chat/service.js";
import { ChatRequestParser } from "../src/chat/validation.js";
import { OpenAiFormatter, OpenAiStreamFormatter } from "../src/chat/openai.js";
import type { ChatMessage } from "../src/domain/models.js";
import { ModelCatalog } from "../src/provider/catalog.js";
import type { WorkersAiProvider } from "../src/provider/workersAi.js";
import { FakeProvider } from "./helpers.js";

const messages: ChatMessage[] = [{ role: "user", content: "Translate to Chinese: hello" }];

const makeService = (provider: FakeProvider, defaultModel = "@cf/fake/model") =>
  new ChatService(
    provider as unknown as WorkersAiProvider,
    new ModelCatalog(defaultModel),
    defaultModel,
  );

const parse = (body: Record<string, unknown>) => new ChatRequestParser().parse(body);

describe("ChatService", () => {
  it("forwards messages and maps unknown models to the default", async () => {
    const provider = new FakeProvider();
    const outcome = await makeService(provider).complete(
      parse({ model: "gpt-4o-mini", messages }),
      "req-1",
    );

    expect(outcome.result.text).toBe("T:Translate to Chinese: hello");
    expect(outcome.result.model).toBe("@cf/fake/model");
    expect(outcome.requestedModel).toBe("gpt-4o-mini");
    expect(provider.calls[0]?.metadata).toMatchObject({ mode: "chat" });
  });

  it("resolves catalog shorthands", async () => {
    const provider = new FakeProvider();
    await makeService(provider).complete(parse({ model: "glm-4.7-flash", messages }), "r");

    expect(provider.calls[0]?.model).toBe("@cf/zai-org/glm-4.7-flash");
  });

  it("appends translation hints as a system rule", async () => {
    const provider = new FakeProvider();
    await makeService(provider).complete(
      parse({
        messages,
        target_lang: "zh-CN",
        tone: "formal",
        glossary: { edge: "边缘" },
      }),
      "req-2",
    );

    const system = provider.calls[0]?.messages.at(-1);
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("Translate the result into zh-CN.");
    expect(system?.content).toContain("tone: formal");
    expect(system?.content).toContain("edge => 边缘");
  });

  it("keeps messages untouched without hints", async () => {
    const provider = new FakeProvider();
    await makeService(provider).complete(parse({ messages }), "r");

    expect(provider.calls[0]?.messages.map((message) => message.role)).toEqual(["user"]);
  });
});

describe("OpenAiFormatter", () => {
  it("renders a chat completion", () => {
    const body = new OpenAiFormatter().completion(
      {
        text: "你好",
        model: "@cf/fake/model",
        usage: { promptTokens: 10, completionTokens: 5 },
        durationMs: 42,
      },
      "abc",
      1700000000,
    );

    expect(body).toMatchObject({
      id: "chatcmpl-abc",
      object: "chat.completion",
      created: 1700000000,
      model: "@cf/fake/model",
    });
    expect((body.choices as Array<Record<string, unknown>>)[0]).toMatchObject({
      index: 0,
      message: { role: "assistant", content: "你好" },
      finish_reason: "stop",
    });
    expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("lists models", () => {
    const body = new OpenAiFormatter().models(["@cf/a", "@cf/b"]);
    expect(body.object).toBe("list");
    expect((body.data as Array<Record<string, unknown>>).map((entry) => entry.id)).toEqual(["@cf/a", "@cf/b"]);
  });
});

describe("OpenAiStreamFormatter", () => {
  it("re-frames Workers AI chunks into OpenAI deltas", async () => {
    const provider = new FakeProvider();
    const { stream } = await makeService(provider).stream(parse({ messages, stream: true }), "s1");
    const output = await new Response(
      new OpenAiStreamFormatter().transform(stream, {
        requestId: "s1",
        created: 1700000000,
        model: "@cf/fake/model",
        includeUsage: false,
      }),
    ).text();

    const events = output.split("\n").filter((line) => line.startsWith("data: "));
    expect(events.at(-1)).toBe("data: [DONE]");
    const payloads = events.slice(0, -1).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    expect(payloads[0]?.choices).toEqual([
      { index: 0, delta: { role: "assistant" }, logprobs: null, finish_reason: null },
    ]);
    const contents = payloads
      .map((payload) => (payload.choices as Array<{ delta: Record<string, unknown> }>)[0]?.delta.content)
      .filter(Boolean)
      .join("");
    expect(contents).toBe("你好");
    expect(payloads.at(-1)?.choices).toEqual([
      { index: 0, delta: {}, logprobs: null, finish_reason: "stop" },
    ]);
  });

  it("passes through already OpenAI shaped chunks", async () => {
    const provider = new FakeProvider();
    provider.streamFrames = [
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { stream } = await makeService(provider).stream(parse({ messages, stream: true }), "s2");
    const output = await new Response(
      new OpenAiStreamFormatter().transform(stream, {
        requestId: "s2",
        created: 1,
        model: "@cf/fake/model",
        includeUsage: false,
      }),
    ).text();

    expect(output).toContain('"content":"hi"');
    expect(output.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("emits usage on the final chunk when requested", async () => {
    const provider = new FakeProvider();
    provider.streamFrames = ['data: {"response":"hi","usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n'];
    const { stream } = await makeService(provider).stream(
      parse({ messages, stream: true, stream_options: { include_usage: true } }),
      "s3",
    );
    const output = await new Response(
      new OpenAiStreamFormatter().transform(stream, {
        requestId: "s3",
        created: 1,
        model: "@cf/fake/model",
        includeUsage: true,
      }),
    ).text();

    expect(output).toContain('"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}');
  });
});
