/** OpenAI-compatible chat completion use case, with true token streaming. */

import type { ChatMessage, ChatOutcome, ChatRequest, Metadata } from "../domain/models.js";
import { ApiError, upstreamError } from "../http/errors.js";
import type { ModelCatalog } from "../provider/catalog.js";
import type { WorkersAiProvider } from "../provider/workersAi.js";
import { cacheKey } from "../translate/service.js";

export class ChatService {
  constructor(
    private readonly provider: WorkersAiProvider,
    private readonly catalog: ModelCatalog,
    private readonly defaultModel: string,
  ) {}

  listModels(): string[] {
    const models = [this.defaultModel];
    for (const id of this.catalog.ids()) if (!models.includes(id)) models.push(id);
    return models;
  }

  resolveModel(request: ChatRequest): string {
    const requested = request.model;
    if (!requested) return this.defaultModel;
    const resolved = this.catalog.resolve(requested);
    if (resolved && resolved.startsWith("@cf/")) return resolved;
    return this.defaultModel;
  }

  buildMessages(request: ChatRequest): ChatMessage[] {
    const extra = this.translationRules(request);
    return extra
      ? [...request.messages, { role: "system", content: extra }]
      : [...request.messages];
  }

  async complete(request: ChatRequest, requestId: string): Promise<ChatOutcome> {
    const started = Date.now();
    const model = this.resolveModel(request);
    const messages = this.buildMessages(request);

    try {
      const completion = await this.provider.complete(messages, {
        model,
        metadata: this.metadata(request, requestId, messages),
        cacheKey: await cacheKey(model, JSON.stringify(messages), request.model ?? "", ""),
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      });

      return {
        result: { text: completion.text, model, usage: completion.usage, durationMs: Date.now() - started },
        stream: request.stream,
        includeUsage: request.includeUsage,
        requestedModel: request.model,
      };
    } catch (error) {
      throw normalizeError(error, "Chat completion failed");
    }
  }

  async stream(
    request: ChatRequest,
    requestId: string,
  ): Promise<{ stream: ReadableStream<Uint8Array>; model: string }> {
    const model = this.resolveModel(request);
    const messages = this.buildMessages(request);
    try {
      const stream = await this.provider.stream(messages, {
        model,
        metadata: this.metadata(request, requestId, messages),
        cacheKey: await cacheKey(model, JSON.stringify(messages), request.model ?? "", ""),
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      });
      return { stream, model };
    } catch (error) {
      throw normalizeError(error, "Chat stream failed");
    }
  }

  private translationRules(request: ChatRequest): string {
    const lines: string[] = [];
    if (request.targetLang) lines.push(`Translate the result into ${request.targetLang}.`);
    if (request.tone) lines.push(`Match the requested tone: ${request.tone}.`);
    if (Object.keys(request.glossary).length > 0) {
      lines.push("Always use these glossary translations verbatim:");
      for (const [term, translated] of Object.entries(request.glossary)) {
        lines.push(`- ${term} => ${translated}`);
      }
    }
    if (lines.length === 0) return "";
    return ["Additional rules:", ...lines].join("\n");
  }

  private metadata(request: ChatRequest, requestId: string, messages: ChatMessage[]): Metadata {
    return {
      request_id: requestId,
      mode: "chat",
      messages: messages.length,
      chars: messages.reduce((total, message) => total + message.content.length, 0),
      stream: request.stream,
    };
  }
}

function normalizeError(error: unknown, prefix: string): ApiError {
  if (error instanceof ApiError) return error;
  return upstreamError(`${prefix}: ${String(error)}`);
}
