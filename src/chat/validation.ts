/** Validation for OpenAI-compatible chat completion requests. */

import type { ChatMessage, ChatRequest } from "../domain/models.js";
import { invalidRequest } from "../http/errors.js";

const SUPPORTED_ROLES = new Set(["system", "user", "assistant", "developer", "tool"]);
const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_TEXT_HARD_LIMIT = 200_000;
const MAX_TONE_CHARS = 120;
const MAX_GLOSSARY_ENTRIES = 50;
const MAX_COMPLETION_TOKENS = 8192;

export class ChatRequestParser {
  private readonly maxTextChars: number;

  constructor(maxTextChars = 20_000) {
    this.maxTextChars = Math.min(maxTextChars, MAX_TEXT_HARD_LIMIT);
  }

  parse(payload: unknown): ChatRequest {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw invalidRequest("Request body must be a JSON object.");
    }
    const body = payload as Record<string, unknown>;

    return {
      messages: this.messages(body),
      model: this.model(body),
      stream: this.bool(body, "stream", false),
      includeUsage: this.includeUsage(body),
      temperature: this.temperature(body),
      maxTokens: this.maxTokens(body),
      tone: this.tone(body),
      targetLang: this.targetLang(body),
      glossary: this.glossary(body),
    };
  }

  private messages(body: Record<string, unknown>): ChatMessage[] {
    const raw = body.messages;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw invalidRequest("Field 'messages' is required and must be a non-empty array.", "messages");
    }
    if (raw.length > MAX_MESSAGES) {
      throw invalidRequest(`Field 'messages' supports at most ${MAX_MESSAGES} entries.`, "messages");
    }

    let totalChars = 0;
    const messages = raw.map((item, index) => {
      const message = this.message(item, index);
      totalChars += message.content.length;
      return message;
    });

    if (totalChars > this.maxTextChars) {
      throw invalidRequest(`Conversation exceeds the ${this.maxTextChars} character limit.`, "messages");
    }
    return messages;
  }

  private message(item: unknown, index: number): ChatMessage {
    if (typeof item !== "object" || item === null) {
      throw invalidRequest(`messages[${index}] must be an object.`, `messages[${index}]`);
    }
    const record = item as Record<string, unknown>;
    const role = record.role;
    if (typeof role !== "string" || !SUPPORTED_ROLES.has(role)) {
      throw invalidRequest(
        `messages[${index}].role must be one of ${[...SUPPORTED_ROLES].join(", ")}.`,
        `messages[${index}].role`,
      );
    }

    const content = contentText(record.content, index);
    if (content.length > MAX_MESSAGE_CHARS) {
      throw invalidRequest(`messages[${index}].content is too long.`, `messages[${index}].content`);
    }
    return { role: role as ChatMessage["role"], content };
  }

  private model(body: Record<string, unknown>): string | null {
    const raw = body.model;
    if (typeof raw !== "string") return null;
    return raw.trim().slice(0, 120) || null;
  }

  private bool(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
    const raw = body[field];
    return typeof raw === "boolean" ? raw : fallback;
  }

  private includeUsage(body: Record<string, unknown>): boolean {
    const options = body.stream_options;
    if (typeof options !== "object" || options === null) return false;
    const include = (options as Record<string, unknown>).include_usage;
    return typeof include === "boolean" ? include : false;
  }

  private temperature(body: Record<string, unknown>): number | null {
    const raw = body.temperature;
    if (typeof raw !== "number" || Number.isNaN(raw)) return null;
    return Math.min(Math.max(raw, 0), 2);
  }

  private maxTokens(body: Record<string, unknown>): number | null {
    for (const name of ["max_tokens", "max_completion_tokens"]) {
      const raw = body[name];
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return Math.min(Math.floor(raw), MAX_COMPLETION_TOKENS);
      }
    }
    return null;
  }

  private tone(body: Record<string, unknown>): string | null {
    const raw = body.tone;
    if (typeof raw !== "string") return null;
    return raw.trim().slice(0, MAX_TONE_CHARS) || null;
  }

  private targetLang(body: Record<string, unknown>): string | null {
    const raw = body.target_lang;
    if (typeof raw !== "string") return null;
    return raw.trim().slice(0, 20) || null;
  }

  private glossary(body: Record<string, unknown>): Record<string, string> {
    const raw = body.glossary;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const glossary: Record<string, string> = {};
    for (const [term, translated] of Object.entries(raw as Record<string, unknown>).slice(
      0,
      MAX_GLOSSARY_ENTRIES,
    )) {
      if (typeof translated !== "string") continue;
      const cleanTerm = term.trim();
      const cleanTranslated = translated.trim();
      if (cleanTerm && cleanTranslated) glossary[cleanTerm] = cleanTranslated;
    }
    return glossary;
  }
}

function contentText(value: unknown, index: number): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const part of value) {
      if (typeof part === "string") parts.push(part);
      else if (typeof part === "object" && part !== null) {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("");
  }
  throw invalidRequest(
    `messages[${index}].content must be a string or text parts array.`,
    `messages[${index}].content`,
  );
}
