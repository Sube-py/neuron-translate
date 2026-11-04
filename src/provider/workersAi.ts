/** Workers AI chat provider routed through AI Gateway. */

import type { ChatMessage, Metadata, TokenUsage } from "../domain/models.js";
import { upstreamError } from "../http/errors.js";
import { parseCompletion, shapeOf, type Completion } from "./response.js";

export interface CompleteOptions {
  model?: string | null;
  metadata?: Metadata | null;
  cacheKey?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
}

export interface ProviderOptions {
  gatewayId: string;
  temperature: number;
  maxOutputTokens: number | null;
  cacheTtl: number;
  collectLogs: boolean;
}

export interface GatewayOptions {
  gateway: {
    id: string;
    collectLog?: boolean;
    cacheTtl?: number;
    cacheKey?: string;
    metadata?: Metadata;
  };
}

export class WorkersAiProvider {
  readonly model: string;
  readonly gatewayId: string;

  constructor(
    private readonly binding: Ai,
    model: string,
    private readonly options: ProviderOptions,
  ) {
    this.model = model;
    this.gatewayId = options.gatewayId;
  }

  gatewayOptions(metadata?: Metadata | null, cacheKey?: string | null): GatewayOptions {
    const gateway: GatewayOptions["gateway"] = {
      id: this.options.gatewayId,
      collectLog: this.options.collectLogs,
    };
    if (this.options.cacheTtl > 0 && cacheKey) {
      gateway.cacheTtl = this.options.cacheTtl;
      gateway.cacheKey = cacheKey;
    }
    if (metadata && Object.keys(metadata).length > 0) gateway.metadata = metadata;
    return { gateway };
  }

  private inputs(messages: ChatMessage[], options: CompleteOptions): Record<string, unknown> {
    const maxTokens = options.maxTokens === undefined ? this.options.maxOutputTokens : options.maxTokens;
    const temperature = options.temperature ?? this.options.temperature;
    const inputs: Record<string, unknown> = { messages, temperature };
    if (maxTokens !== null && maxTokens !== undefined) inputs.max_tokens = maxTokens;
    return inputs;
  }

  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const modelId = options.model ?? this.model;
    let raw: unknown;
    try {
      raw = await this.binding.run(
        modelId,
        this.inputs(messages, options) as never,
        this.gatewayOptions(options.metadata, options.cacheKey) as never,
      );
    } catch (error) {
      throw upstreamError(`Workers AI call failed: ${describe(error)}`);
    }

    const completion = parseCompletion(raw);
    if (!completion.text) {
      if (completion.reasoning) {
        throw upstreamError(
          "Model spent its whole output budget on reasoning, so no content was returned. " +
            `Raise max_tokens or use a non-reasoning model (shape: ${shapeOf(raw)}).`,
          "reasoning_budget_exhausted",
        );
      }
      throw upstreamError(`Workers AI returned an empty translation (shape: ${shapeOf(raw)}).`, "empty_response");
    }
    return completion;
  }

  /**
   * Streams a completion. The upstream stream uses Workers AI framing, so the
   * caller re-frames it into the OpenAI wire format.
   */
  async stream(
    messages: ChatMessage[],
    options: CompleteOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const modelId = options.model ?? this.model;
    const inputs = { ...this.inputs(messages, options), stream: true };
    try {
      const result = (await this.binding.run(
        modelId,
        inputs as never,
        this.gatewayOptions(options.metadata, options.cacheKey) as never,
      )) as unknown as ReadableStream<Uint8Array> | Record<string, unknown>;
      if (result instanceof ReadableStream) return result;
      return singleChunkStream(result);
    } catch (error) {
      throw upstreamError(`Workers AI stream failed: ${describe(error)}`);
    }
  }
}

function singleChunkStream(raw: Record<string, unknown>): ReadableStream<Uint8Array> {
  const completion = parseCompletion(raw);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: completion.text })}\n\n`));
      controller.close();
    },
  });
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export type { Completion, TokenUsage };
