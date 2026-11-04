import { describe, expect, it } from "vitest";

import { ChatRequestParser } from "../src/chat/validation.js";
import { ApiError } from "../src/http/errors.js";
import { TranslationRequestParser } from "../src/translate/validation.js";

describe("TranslationRequestParser", () => {
  it("parses a minimal payload", () => {
    const request = new TranslationRequestParser().parse({ text: "hi" });
    expect(request).toEqual({
      text: "hi",
      targetLang: "en",
      sourceLang: "auto",
      tone: null,
      glossary: {},
      preserveFormatting: true,
      model: null,
    });
  });

  it("parses a full payload", () => {
    const request = new TranslationRequestParser().parse({
      text: "  hello  ",
      target_lang: "zh-CN",
      source_lang: "en",
      tone: "formal",
      glossary: { " workers ": " 无服务器 " },
      preserve_formatting: false,
      model: " glm-4.7-flash ",
    });

    expect(request.text).toBe("  hello  ");
    expect(request.glossary).toEqual({ workers: "无服务器" });
    expect(request.preserveFormatting).toBe(false);
    expect(request.model).toBe("glm-4.7-flash");
  });

  it.each([null, [], "text", 42])("rejects %s as body", (payload) => {
    expect(() => new TranslationRequestParser().parse(payload)).toThrow(ApiError);
  });

  it.each(["", "   ", null, 123])("rejects text %s", (text) => {
    expect(() => new TranslationRequestParser().parse({ text })).toThrow(/Field 'text'/);
  });

  it("rejects oversized text", () => {
    expect(() => new TranslationRequestParser(10).parse({ text: "a".repeat(11) })).toThrow(/character limit/);
  });

  it("rejects a bad glossary", () => {
    expect(() => new TranslationRequestParser().parse({ text: "hi", glossary: { a: 1 } })).toThrow(
      /Glossary keys and values/,
    );
  });

  it("rejects too many glossary entries", () => {
    const glossary = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`t${index}`, `v${index}`]));
    expect(() => new TranslationRequestParser().parse({ text: "hi", glossary })).toThrow(/at most 50/);
  });

  it("rejects a non-boolean flag", () => {
    expect(() => new TranslationRequestParser().parse({ text: "hi", preserve_formatting: "yes" })).toThrow(
      /must be a boolean/,
    );
  });

  it("ignores a blank model", () => {
    expect(new TranslationRequestParser().parse({ text: "hi", model: "  " }).model).toBeNull();
  });
});

describe("ChatRequestParser", () => {
  const messages = [{ role: "user", content: "Translate to Chinese: hello" }];

  it("parses a minimal OpenAI body", () => {
    const request = new ChatRequestParser().parse({ messages });
    expect(request.messages).toEqual(messages);
    expect(request.stream).toBe(false);
    expect(request.temperature).toBeNull();
  });

  it("parses a full OpenAI body", () => {
    const request = new ChatRequestParser().parse({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You translate." },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 5,
      max_tokens: 999999,
      target_lang: "zh-CN",
      tone: "formal",
      glossary: { workers: "无服务器" },
      presence_penalty: 0.5,
    });

    expect(request.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(request.messages[1]?.content).toBe("hi");
    expect(request.stream).toBe(true);
    expect(request.includeUsage).toBe(true);
    expect(request.temperature).toBe(2);
    expect(request.maxTokens).toBe(8192);
    expect(request.glossary).toEqual({ workers: "无服务器" });
  });

  it.each([null, [], "x"])("rejects %s as body", (payload) => {
    expect(() => new ChatRequestParser().parse(payload)).toThrow(ApiError);
  });

  it.each([null, [], "hello", [{ role: "user" }]])("rejects messages %s", (value) => {
    expect(() => new ChatRequestParser().parse({ messages: value })).toThrow(ApiError);
  });

  it("rejects unknown roles", () => {
    expect(() => new ChatRequestParser().parse({ messages: [{ role: "wizard", content: "hi" }] })).toThrow(
      /role must be one of/,
    );
  });

  it("rejects oversized conversations", () => {
    expect(() => new ChatRequestParser(5).parse({ messages })).toThrow(/character limit/);
  });
});
