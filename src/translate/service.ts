/** Translation orchestration: chunking, concurrency, tracing metadata. */

import {
  addUsage,
  EMPTY_USAGE,
  type Metadata,
  type TranslationRequest,
  type TranslationResult,
  type TokenUsage,
} from "../domain/models.js";
import { ApiError, upstreamError } from "../http/errors.js";
import type { WorkersAiProvider } from "../provider/workersAi.js";
import { TextChunker } from "./chunker.js";
import { PromptBuilder } from "./prompts.js";

export interface TranslationServiceOptions {
  maxConcurrency?: number;
  maxOutputTokens?: number | null;
}

export class TranslationService {
  private readonly prompts = new PromptBuilder();
  private readonly maxConcurrency: number;

  constructor(
    private readonly provider: WorkersAiProvider,
    private readonly chunker = new TextChunker(),
    private readonly options: TranslationServiceOptions = {},
  ) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
  }

  async translate(request: TranslationRequest, requestId: string): Promise<TranslationResult> {
    const started = Date.now();
    const model = request.model ?? this.provider.model;
    const chunks = this.chunker.split(request.text);
    const systemPrompt = this.prompts.systemPrompt(request);

    const completions = await mapWithConcurrency(
      chunks,
      this.maxConcurrency,
      async (chunk, index) =>
        this.completeChunk(request, requestId, chunk.text, index, chunks.length, model, systemPrompt),
    );

    let usage: TokenUsage = EMPTY_USAGE;
    for (const completion of completions) usage = addUsage(usage, completion.usage);

    const text = chunks
      .map((chunk, index) => `${completions[index]?.text ?? ""}${chunk.separator}`)
      .join("")
      .trim();

    return {
      text,
      chunkCount: chunks.length,
      cachedChunks: completions.filter((completion) => completion.cached).length,
      model,
      gatewayId: this.provider.gatewayId,
      usage,
      durationMs: Date.now() - started,
    };
  }

  private async completeChunk(
    request: TranslationRequest,
    requestId: string,
    text: string,
    index: number,
    total: number,
    model: string,
    systemPrompt: string,
  ) {
    const metadata: Metadata = {
      request_id: requestId,
      target_lang: request.targetLang,
      source_lang: request.sourceLang,
      chunk: `${index + 1}/${total}`,
      chars: text.length,
    };

    try {
      return await this.provider.complete(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        {
          model,
          metadata,
          cacheKey: await cacheKey(model, systemPrompt, text, request.targetLang),
          maxTokens: this.options.maxOutputTokens ?? null,
        },
      );
    } catch (error) {
      if (error instanceof ApiError) {
        throw new ApiError(error.message, {
          code: error.code,
          status: error.status,
          field: error.field ?? `chunks[${index}]`,
        });
      }
      throw upstreamError(`Translation chunk ${index} failed: ${String(error)}`);
    }
  }
}

export async function cacheKey(
  model: string,
  systemPrompt: string,
  text: string,
  targetLang: string,
): Promise<string> {
  const payload = JSON.stringify({ model, system: systemPrompt, text, target_lang: targetLang });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  limit: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index] as TItem;
      results[index] = await worker(item, index);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(runners);
  return results;
}
