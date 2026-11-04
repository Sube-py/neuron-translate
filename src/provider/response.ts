/** Normalise the many response shapes returned by Workers AI models. */

import type { TokenUsage } from "../domain/models.js";

export interface Completion {
  text: string;
  usage: TokenUsage;
  cached: boolean;
  reasoning: string;
}

type Unknown = Record<string, unknown> | null | undefined;

function field(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[name];
}

function asRecord(value: unknown): Unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function blocksText(message: unknown): string {
  const content = field(message, "content");
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else {
      const text = field(block, "text");
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("").trim();
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (!Array.isArray(output)) return "";
  return output
    .map((item) => (typeof item === "string" ? item : blocksText(item)))
    .join("")
    .trim();
}

export function textOf(raw: unknown): string {
  const direct = field(raw, "response");
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const nested = field(field(raw, "result"), "response");
  if (typeof nested === "string" && nested.trim()) return nested.trim();

  const outputTextValue = field(raw, "output_text");
  if (typeof outputTextValue === "string" && outputTextValue.trim()) return outputTextValue.trim();

  const choices = field(raw, "choices");
  if (Array.isArray(choices) && choices.length > 0) {
    const text = blocksText(field(choices[0], "message"));
    if (text) return text;
  }

  return outputText(field(raw, "output"));
}

export function usageOf(raw: unknown): TokenUsage {
  const usage = asRecord(field(raw, "usage"));
  if (!usage) return { promptTokens: 0, completionTokens: 0 };
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return { promptTokens: Number(prompt) || 0, completionTokens: Number(completion) || 0 };
}

export function cachedOf(raw: unknown): boolean {
  for (const name of ["cached", "cache_hit", "cachedResponse"]) {
    const value = field(raw, name);
    if (typeof value === "boolean") return value;
  }
  return false;
}

export function reasoningOf(raw: unknown): string {
  const choices = field(raw, "choices");
  if (Array.isArray(choices) && choices.length > 0) {
    const message = field(choices[0], "message");
    for (const name of ["reasoning", "reasoning_content"]) {
      const value = field(message, name);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  const direct = field(raw, "reasoning");
  return typeof direct === "string" ? direct.trim() : "";
}

export function shapeOf(raw: unknown): string {
  if (raw === null || raw === undefined) return "null";
  if (typeof raw !== "object") return typeof raw;
  return `{${Object.keys(raw as Record<string, unknown>).slice(0, 8).join(",")}}`;
}

export function parseCompletion(raw: unknown): Completion {
  return {
    text: textOf(raw),
    usage: usageOf(raw),
    cached: cachedOf(raw),
    reasoning: reasoningOf(raw),
  };
}
