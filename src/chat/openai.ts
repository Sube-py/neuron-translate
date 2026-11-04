/** OpenAI wire formats: chat completions, streaming frames, models, errors. */

import type { ChatResult } from "../domain/models.js";
import { ApiError, openAiErrorPayload } from "../http/errors.js";

export const SSE_DONE = "data: [DONE]\n\n";

export class OpenAiFormatter {
  completionId(requestId: string): string {
    return `chatcmpl-${requestId}`;
  }

  completion(result: ChatResult, requestId: string, created: number): Record<string, unknown> {
    return {
      id: this.completionId(requestId),
      object: "chat.completion",
      created,
      model: result.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.text },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: this.usage(result),
    };
  }

  models(ids: string[]): Record<string, unknown> {
    const created = Math.floor(Date.now() / 1000);
    return {
      object: "list",
      data: ids.map((id) => ({ id, object: "model", created, owned_by: "cloudflare" })),
    };
  }

  error(error: ApiError, requestId: string): Record<string, unknown> {
    return openAiErrorPayload(error, requestId);
  }

  private usage(result: ChatResult): Record<string, number> {
    return {
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      total_tokens: result.usage.promptTokens + result.usage.completionTokens,
    };
  }
}

export interface StreamContext {
  requestId: string;
  created: number;
  model: string;
  includeUsage: boolean;
}

/**
 * Re-frames the Workers AI stream (and any OpenAI-shaped chunks it may already
 * emit) into OpenAI `chat.completion.chunk` events.
 */
export class OpenAiStreamFormatter {
  constructor(private readonly formatter = new OpenAiFormatter()) {}

  transform(upstream: ReadableStream<Uint8Array>, context: StreamContext): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const completionId = this.formatter.completionId(context.requestId);
    let buffer = "";
    let finished = false;
    let usage: Record<string, number> | null = null;

    const frame = (delta: Record<string, unknown>, finishReason: string | null) => {
      const chunk: Record<string, unknown> = {
        id: completionId,
        object: "chat.completion.chunk",
        created: context.created,
        model: context.model,
        choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
      };
      if (finishReason !== null && usage && context.includeUsage) chunk.usage = usage;
      return `data: ${JSON.stringify(chunk)}\n\n`;
    };

    return upstream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        start: (controller) => {
          controller.enqueue(encoder.encode(frame({ role: "assistant" }, null)));
        },
        transform: (chunk, controller) => {
          buffer += decoder.decode(chunk, { stream: true });
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";
          for (const line of parts) {
            const payload = parseSseLine(line);
            if (payload === null) continue;
            if (payload === DONE) {
              finished = true;
              continue;
            }
            if (payload.usage) usage = payload.usage;
            const content = payload.content;
            if (content) controller.enqueue(encoder.encode(frame({ content }, null)));
            if (payload.finishReason) finished = true;
          }
        },
        flush: (controller) => {
          if (!finished) {
            controller.enqueue(encoder.encode(frame({}, "stop")));
            controller.enqueue(encoder.encode(SSE_DONE));
            return;
          }
          controller.enqueue(encoder.encode(frame({}, "stop")));
          controller.enqueue(encoder.encode(SSE_DONE));
        },
      }),
    );
  }
}

const DONE = Symbol("done");

interface ParsedSse {
  content: string | null;
  finishReason: string | null;
  usage: Record<string, number> | null;
}

function parseSseLine(line: string): ParsedSse | typeof DONE | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const raw = trimmed.slice(5).trim();
  if (!raw) return null;
  if (raw === "[DONE]") return DONE;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const record = json as Record<string, unknown>;

  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>;
    const delta = choice.delta as Record<string, unknown> | undefined;
    const message = choice.message as Record<string, unknown> | undefined;
    const content = typeof delta?.content === "string" ? delta.content : typeof message?.content === "string" ? message.content : null;
    return {
      content,
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
      usage: normalizeUsage(record.usage),
    };
  }

  const response = record.response;
  return {
    content: typeof response === "string" && response.length > 0 ? response : null,
    finishReason: null,
    usage: normalizeUsage(record.usage),
  };
}

function normalizeUsage(raw: unknown): Record<string, number> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usage = raw as Record<string, unknown>;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!prompt && !completion) return null;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}
