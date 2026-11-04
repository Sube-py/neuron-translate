import { describe, expect, it } from "vitest";

import { TtsCatalog } from "../src/audio/catalog.js";
import { SpeechService } from "../src/audio/service.js";
import { ChatService } from "../src/chat/service.js";
import { HttpApp } from "../src/http/router.js";
import { Logger } from "../src/observability/logger.js";
import { ModelCatalog } from "../src/provider/catalog.js";
import type { WorkersAiProvider } from "../src/provider/workersAi.js";
import { TextChunker } from "../src/translate/chunker.js";
import { TranslationService } from "../src/translate/service.js";
import { FakeProvider, testSettings } from "./helpers.js";

interface AppOptions {
  apiToken?: string | null;
  usageFactory?: () => { fetch: () => Promise<unknown> };
}

function makeApp(provider = new FakeProvider(), options: AppOptions = {}) {
  const settings = testSettings({
    model: provider.model,
    apiToken: options.apiToken ?? null,
  });
  const catalog = new ModelCatalog(settings.model);
  const translation = new TranslationService(provider as unknown as WorkersAiProvider, new TextChunker(1000));
  const chat = new ChatService(provider as unknown as WorkersAiProvider, catalog, settings.model);

  const app = new HttpApp({
    settings,
    provider: provider as unknown as WorkersAiProvider,
    translation,
    chat,
    catalog,
    speech: new SpeechService(fakeBinding()),
    ttsCatalog: new TtsCatalog(),
    logger: new Logger("trans", false),
    usageClientFactory: options.usageFactory,
  });
  return { app, provider };
}

function fakeBinding(audio = "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAAD") {
  return {
    async run(model: string) {
      if (model.startsWith("@cf/deepgram/")) {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
      }
      return { audio: audio };
    },
  } as unknown as Ai;
}

const call = (app: HttpApp, path: string, init: RequestInit = {}) =>
  app.handle(new Request(`https://x.dev${path}`, init));

const postJson = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

const CHAT_BODY = { messages: [{ role: "user", content: "Say hello" }] };

describe("routing", () => {
  it("serves healthz without auth", async () => {
    const { app } = makeApp();
    const response = await call(app, "/healthz");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("translates", async () => {
    const { app } = makeApp();
    const response = await call(
      app,
      "/translate",
      postJson({ text: "Hello", target_lang: "zh-CN" }, { "x-request-id": "abc123" }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.translation).toBe("T:Hello");
    expect(body.request_id).toBe("abc123");
    expect((body.meta as Record<string, unknown>).model).toBe("@cf/fake/model");
  });

  it("uses cf-ray as request id", async () => {
    const { app } = makeApp();
    const response = await call(app, "/translate", postJson({ text: "Hello" }, { "cf-ray": "8f2-LHR" }));
    expect(((await response.json()) as Record<string, unknown>).request_id).toBe("8f2-LHR");
  });

  it("rejects a missing token", async () => {
    const { app } = makeApp(undefined, { apiToken: "secret" });
    const response = await call(app, "/translate", postJson({ text: "Hi" }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect((body.error as Record<string, unknown>).code).toBe("unauthorized");
  });

  it("accepts a bearer token", async () => {
    const { app, provider } = makeApp(undefined, { apiToken: "secret" });
    const response = await call(
      app,
      "/translate",
      postJson({ text: "Hi" }, { authorization: "Bearer secret" }),
    );

    expect(response.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
  });

  it("rejects a wrong api key", async () => {
    const { app } = makeApp(undefined, { apiToken: "secret" });
    const response = await call(app, "/translate", postJson({ text: "Hi" }, { "x-api-key": "nope" }));
    expect(response.status).toBe(401);
  });

  it("answers preflight with CORS headers", async () => {
    const { app } = makeApp();
    const response = await call(app, "/translate", { method: "OPTIONS", headers: { origin: "https://a.dev" } });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects invalid JSON", async () => {
    const { app } = makeApp();
    const response = await call(app, "/translate", {
      method: "POST",
      body: "nope",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects a non object body", async () => {
    const { app } = makeApp();
    const response = await call(app, "/translate", postJson([1, 2]));
    expect(response.status).toBe(400);
  });

  it("returns the validation field", async () => {
    const { app } = makeApp();
    const body = (await (await call(app, "/translate", postJson({}))).json()) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).field).toBe("text");
  });

  it("rejects unsupported methods", async () => {
    const { app } = makeApp();
    const response = await call(app, "/translate");
    expect(response.status).toBe(405);
  });

  it("returns 404 for unknown routes", async () => {
    const { app } = makeApp();
    const body = (await (await call(app, "/nope")).json()) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe("not_found");
  });

  it("rejects oversized bodies", async () => {
    const { app } = makeApp();
    const response = await call(app, "/translate", {
      ...postJson({ text: "Hi" }),
      headers: { "content-type": "application/json", "content-length": "5000000" },
    });
    expect(response.status).toBe(413);
  });
});

describe("OpenAI compatible routes", () => {
  it("returns a chat completion", async () => {
    const { app } = makeApp();
    const response = await call(
      app,
      "/v1/chat/completions",
      postJson(CHAT_BODY, { "x-request-id": "c1" }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.object).toBe("chat.completion");
    expect(body.id).toBe("chatcmpl-c1");
    expect(body.usage).toMatchObject({ total_tokens: 15 });
  });

  it("streams SSE", async () => {
    const { app } = makeApp();
    const response = await call(app, "/v1/chat/completions", postJson({ ...CHAT_BODY, stream: true }));

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const text = await response.text();
    expect(text).toContain('"delta":{"content":"你"}');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it.each(["/v1/chat/completions", "/chat/completions", "/openai/v1/chat/completions"])(
    "accepts %s",
    async (path) => {
      const { app } = makeApp();
      const response = await call(app, path, postJson(CHAT_BODY));
      expect(response.status).toBe(200);
    },
  );

  it("returns OpenAI shaped errors", async () => {
    const { app } = makeApp(undefined, { apiToken: "secret" });
    const body = (await (await call(app, "/v1/chat/completions", postJson(CHAT_BODY))).json()) as Record<
      string,
      unknown
    >;

    expect((body.error as Record<string, unknown>).type).toBe("authentication_error");
  });

  it("rejects invalid messages with param info", async () => {
    const { app } = makeApp();
    const response = await call(app, "/v1/chat/completions", postJson({ messages: [] }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect((body.error as Record<string, unknown>).param).toBe("messages");
  });

  it("lists models publicly", async () => {
    const { app } = makeApp();
    const response = await call(app, "/v1/models");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.object).toBe("list");
    expect((body.data as Array<Record<string, unknown>>)[0]?.id).toBe("@cf/fake/model");
  });

  it("rejects POST on the models route", async () => {
    const { app } = makeApp();
    expect((await call(app, "/v1/models", { method: "POST" })).status).toBe(405);
  });
});

describe("dashboard api", () => {
  it("returns session info", async () => {
    const { app } = makeApp();
    const body = (await (await call(app, "/api/verify")).json()) as Record<string, unknown>;

    expect(body.ok).toBe(true);
    expect((body.limits as Record<string, unknown>).max_text_chars).toBe(20000);
    expect((body.features as Record<string, unknown>).streaming).toBe(true);
  });

  it("requires a token for session info", async () => {
    const { app } = makeApp(undefined, { apiToken: "secret" });
    expect((await call(app, "/api/verify")).status).toBe(401);
  });

  it("lists the catalog with the default model", async () => {
    const { app } = makeApp();
    const body = (await (await call(app, "/api/models")).json()) as Record<string, unknown>;
    const ids = (body.data as Array<Record<string, unknown>>).map((entry) => entry.id);

    expect(body.default).toBe("@cf/fake/model");
    expect(ids).toContain("@cf/zai-org/glm-4.7-flash");
    expect(ids.every((id) => String(id).startsWith("@cf/"))).toBe(true);
  });

  it("explains missing analytics configuration", async () => {
    const { app } = makeApp();
    const body = (await (await call(app, "/api/usage")).json()) as Record<string, unknown>;

    expect(body.configured).toBe(false);
    expect((body.setup as Record<string, unknown>).secrets).toContain("ANALYTICS_API_TOKEN");
  });

  it("renders a usage report", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const report = {
      toPayload: () => ({
        today: { neurons: 12, percent: 0.12, remaining: 9988, requests: 4 },
        days: [],
        models: [{ label: "@cf/meta/x", requests: 4, neurons: 12 }],
      }),
    };
    const { app } = makeApp(undefined, { usageFactory: () => ({ fetch: async () => report }) });
    const body = (await (await call(app, "/api/usage")).json()) as Record<string, unknown>;

    expect(body.configured).toBe(true);
    expect((body.today as Record<string, unknown>).neurons).toBe(12);
    expect(today).toBeTruthy();
  });

  it("surfaces analytics failures as 502", async () => {
    const { app } = makeApp(undefined, {
      usageFactory: () => ({
        fetch: async () => {
          throw new Error("boom");
        },
      }),
    });
    const response = await call(app, "/api/usage");

    expect(response.status).toBe(502);
    expect(((await response.json()) as Record<string, unknown>).configured).toBe(true);
  });
});

describe("text to speech", () => {
  const speechBody = { input: "Hello there", model: "@cf/myshell-ai/melotts" };

  it("detects the audio container from magic bytes", async () => {
    const { contentTypeOf } = await import("../src/audio/service.js");
    const riff = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]).buffer;
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0]).buffer;
    const frame = new Uint8Array([0xff, 0xfb, 0x90, 0x00]).buffer;

    expect(contentTypeOf(riff)).toBe("audio/wav");
    expect(contentTypeOf(mp3)).toBe("audio/mpeg");
    expect(contentTypeOf(frame)).toBe("audio/mpeg");
  });

  it("returns audio bytes with metadata headers", async () => {
    const { app } = makeApp();
    const response = await call(app, "/v1/audio/speech", postJson(speechBody));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("x-tts-model")).toBe("@cf/myshell-ai/melotts");
    expect(Number(response.headers.get("x-tts-neurons"))).toBeGreaterThan(0);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(10);
  });

  it("supports deepgram models returning a Response", async () => {
    const { app } = makeApp();
    const response = await call(
      app,
      "/v1/audio/speech",
      postJson({ input: "Hello there", model: "aura-1" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tts-model")).toBe("@cf/deepgram/aura-1");
    expect((await response.arrayBuffer()).byteLength).toBe(3);
  });

  it("rejects unknown models with the list hint", async () => {
    const { app } = makeApp();
    const response = await call(app, "/v1/audio/speech", postJson({ input: "hi", model: "nope" }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect((body.error as Record<string, unknown>).param).toBe("model");
  });

  it("rejects a voice the model does not have", async () => {
    const { app } = makeApp();
    const response = await call(
      app,
      "/v1/audio/speech",
      postJson({ input: "hi", model: "aura-1", voice: "nobody" }),
    );
    expect(response.status).toBe(400);
  });

  it("requires auth", async () => {
    const { app } = makeApp(undefined, { apiToken: "secret" });
    expect((await call(app, "/v1/audio/speech", postJson(speechBody))).status).toBe(401);
  });

  it("lists tts models", async () => {
    const { app } = makeApp();
    const body = (await (await call(app, "/api/models?kind=tts")).json()) as Record<string, unknown>;
    const ids = (body.data as Array<Record<string, unknown>>).map((entry) => entry.id);

    expect(ids).toContain("@cf/myshell-ai/melotts");
    expect(ids).toContain("@cf/deepgram/aura-2-en");
    expect(body.default).toBe("@cf/myshell-ai/melotts");
  });
});
