/** HTTP adapter: routing, CORS, auth, error rendering and static assets. */

import { SpeechService } from "../audio/service.js";
import { SpeechRequestParser } from "../audio/validation.js";
import { TtsCatalog } from "../audio/catalog.js";
import { ChatService } from "../chat/service.js";
import { ChatRequestParser } from "../chat/validation.js";
import { OpenAiFormatter, OpenAiStreamFormatter } from "../chat/openai.js";
import type { Settings } from "../config/settings.js";
import { ApiError, legacyErrorPayload, methodNotAllowed, notFound, payloadTooLarge } from "./errors.js";
import { ApiKeyGuard } from "./auth.js";
import { Logger } from "../observability/logger.js";
import { TranslationRequestParser } from "../translate/validation.js";
import { TranslationService } from "../translate/service.js";
import {
  MissingUsageConfiguration,
  UsageClient,
  UsageUnavailable,
} from "../usage/client.js";
import { FREE_NEURONS_PER_DAY } from "../usage/report.js";
import { ModelCatalog } from "../provider/catalog.js";
import type { WorkersAiProvider } from "../provider/workersAi.js";

const MAX_BODY_BYTES = 2_000_000;
const JSON_TYPE = "application/json; charset=utf-8";
const SSE_TYPE = "text/event-stream; charset=utf-8";
const CHAT_SUFFIXES = ["/chat/completions"];
const SPEECH_SUFFIXES = ["/audio/speech"];
const MODELS_SUFFIXES = ["/models"];
const API_PREFIXES = ["/api/", "/v1/", "/translate", "/healthz", "/health"];

interface UsagePayload {
  today: { neurons: number; percent: number };
  [key: string]: unknown;
}

export interface AppDependencies {
  settings: Settings;
  provider: WorkersAiProvider;
  translation: TranslationService;
  chat: ChatService;
  catalog: ModelCatalog;
  speech: SpeechService;
  ttsCatalog: TtsCatalog;
  logger: Logger;
  usageClientFactory?: () => { fetch: () => Promise<unknown> };
}

export class HttpApp {
  private readonly guard: ApiKeyGuard;
  private readonly parser: TranslationRequestParser;
  private readonly chatParser = new ChatRequestParser();
  private readonly speechParser: SpeechRequestParser;
  private readonly formatter = new OpenAiFormatter();
  private readonly streamFormatter = new OpenAiStreamFormatter();

  constructor(private readonly deps: AppDependencies) {
    this.guard = new ApiKeyGuard(deps.settings.apiToken);
    this.parser = new TranslationRequestParser(deps.settings.maxTextChars);
    this.speechParser = new SpeechRequestParser(deps.ttsCatalog);
  }

  static isApiPath(pathname: string): boolean {
    return API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  }

  async handle(request: Request): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const path = url.pathname || "/";
    const method = request.method.toUpperCase();
    const requestId = this.requestId(request);
    const userAgent = (request.headers.get("user-agent") ?? "-").slice(0, 120);
    const cors = this.corsHeaders(request.headers.get("origin"), requestId);

    let response: Response;
    try {
      response = await this.route(request, { path, method, requestId, headers: cors, userAgent });
    } catch (error) {
      const apiError =
        error instanceof ApiError ? error : new ApiError("Unexpected error.", { code: "internal_error", status: 500 });
      if (apiError.status >= 500 && !(error instanceof ApiError)) {
        this.deps.logger.error("request.crashed", {
          request_id: requestId,
          method,
          path,
          message: String(error),
          user_agent: userAgent,
        });
      } else {
        this.deps.logger.warn("request.failed", {
          request_id: requestId,
          method,
          path,
          code: apiError.code,
          status: apiError.status,
          message: apiError.message,
          user_agent: userAgent,
        });
      }
      response = jsonResponse(
        apiError.status,
        this.errorBody(apiError, path, requestId),
        cors,
      );
    }

    this.deps.logger.info("request.completed", {
      request_id: requestId,
      method,
      path,
      status: response.status,
      duration_ms: Date.now() - started,
      user_agent: userAgent,
      streamed: (response.headers.get("content-type") ?? "").startsWith("text/event-stream"),
    });
    return response;
  }

  private async route(
    request: Request,
    context: { path: string; method: string; requestId: string; headers: Record<string, string>; userAgent: string },
  ): Promise<Response> {
    const { path, method, requestId, headers } = context;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers });

    if (method === "GET" && (path === "/health" || path === "/healthz")) {
      return jsonResponse(200, this.health(), headers);
    }

    if (path === "/api/verify") {
      this.guard.verify(request);
      return jsonResponse(200, this.sessionPayload(requestId), headers);
    }

    if (path === "/api/models") {
      this.guard.verify(request);
      const kind = new URL(request.url).searchParams.get("kind");
      const payload =
        kind === "tts"
          ? { default: this.deps.ttsCatalog.defaultModel.id, data: this.deps.ttsCatalog.list() }
          : this.modelsPayload();
      return jsonResponse(200, { request_id: requestId, ...payload }, headers);
    }

    if (path === "/api/usage") {
      return await this.usage(request, requestId, headers);
    }

    if (MODELS_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
      if (method !== "GET") throw methodNotAllowed();
      return jsonResponse(200, this.formatter.models(this.deps.chat.listModels()), headers);
    }

    if (SPEECH_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
      if (method !== "POST") throw methodNotAllowed();
      return await this.speech(request, requestId, headers);
    }

    if (CHAT_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
      if (method !== "POST") throw methodNotAllowed();
      return await this.chatCompletion(request, requestId, headers);
    }

    if (path === "/translate") {
      if (method !== "POST") throw methodNotAllowed();
      return await this.translate(request, requestId, headers);
    }

    if (method === "POST" || /openai|chat|translat|gpt/i.test(`${path} ${context.userAgent}`)) {
      this.deps.logger.warn("request.unknown_chat_path", {
        request_id: requestId,
        method,
        path,
        user_agent: context.userAgent,
      });
    }
    throw notFound(
      `No route matches ${method} ${path}. Use POST /v1/chat/completions, POST /translate, or GET /v1/models.`,
    );
  }

  private async translate(
    request: Request,
    requestId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    this.guard.verify(request);
    const payload = await readJson(request);
    const parsed = this.parser.parse(payload);
    const model = parsed.model ? this.deps.catalog.resolve(parsed.model) : null;
    const result = await this.deps.translation.translate({ ...parsed, model }, requestId);

    this.deps.logger.info("translation.completed", {
      request_id: requestId,
      target_lang: parsed.targetLang,
      source_lang: parsed.sourceLang,
      model: result.model,
      gateway: result.gatewayId,
      chunks: result.chunkCount,
      cached_chunks: result.cachedChunks,
      input_chars: parsed.text.length,
      output_chars: result.text.length,
      duration_ms: result.durationMs,
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
    });

    return jsonResponse(
      200,
      {
        request_id: requestId,
        translation: result.text,
        meta: {
          model: result.model,
          gateway: result.gatewayId,
          chunks: result.chunkCount,
          cached_chunks: result.cachedChunks,
          tokens: {
            prompt: result.usage.promptTokens,
            completion: result.usage.completionTokens,
            total: result.usage.promptTokens + result.usage.completionTokens,
          },
          duration_ms: result.durationMs,
        },
      },
      headers,
    );
  }

  private async speech(
    request: Request,
    requestId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    this.guard.verify(request);
    const payload = await readJson(request);
    const parsed = this.speechParser.parse(payload);
    const result = await this.deps.speech.synthesize(parsed);

    this.deps.logger.info("speech.completed", {
      request_id: requestId,
      model: result.model,
      characters: result.characters,
      bytes: result.audio.byteLength,
      estimated_neurons: result.estimatedNeurons,
      duration_ms: result.durationMs,
    });

    return new Response(result.audio, {
      status: 200,
      headers: {
        ...headers,
        "content-type": result.contentType,
        "cache-control": "no-store",
        "x-tts-model": result.model,
        "x-tts-neurons": String(result.estimatedNeurons),
        "x-tts-duration-ms": String(result.durationMs),
      },
    });
  }

  private async chatCompletion(
    request: Request,
    requestId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    this.guard.verify(request);
    const payload = await readJson(request);
    const parsed = this.chatParser.parse(payload);

    if (parsed.stream) {
      const { stream, model } = await this.deps.chat.stream(parsed, requestId);
      const body = this.streamFormatter.transform(stream, {
        requestId,
        created: Math.floor(Date.now() / 1000),
        model,
        includeUsage: parsed.includeUsage,
      });
      this.deps.logger.info("chat.streamed", {
        request_id: requestId,
        model,
        messages: parsed.messages.length,
        requested_model: parsed.model,
      });
      return new Response(body, {
        status: 200,
        headers: { ...headers, "content-type": SSE_TYPE, "cache-control": "no-cache" },
      });
    }

    const outcome = await this.deps.chat.complete(parsed, requestId);
    this.deps.logger.info("chat.completed", {
      request_id: requestId,
      model: outcome.result.model,
      requested_model: outcome.requestedModel,
      stream: false,
      messages: parsed.messages.length,
      duration_ms: outcome.result.durationMs,
      prompt_tokens: outcome.result.usage.promptTokens,
      completion_tokens: outcome.result.usage.completionTokens,
    });

    return jsonResponse(
      200,
      this.formatter.completion(outcome.result, requestId, Math.floor(Date.now() / 1000)),
      headers,
    );
  }

  private async usage(
    request: Request,
    requestId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    this.guard.verify(request);
    const client = this.buildUsageClient();
    try {
      const report = (await client.fetch()) as { toPayload: () => UsagePayload };
      const payload = { configured: true, ...report.toPayload() };
      this.deps.logger.info("usage.reported", {
        request_id: requestId,
        today_neurons: payload.today.neurons,
        today_percent: payload.today.percent,
      });
      return jsonResponse(200, payload, headers);
    } catch (error) {
      const missing = client instanceof MissingUsageConfiguration;
      const message = error instanceof UsageUnavailable ? error.message : String(error);
      this.deps.logger.warn("usage.unavailable", {
        request_id: requestId,
        configured: !missing,
        message,
      });
      return jsonResponse(
        missing ? 200 : 502,
        {
          configured: !missing,
          free_neurons_per_day: FREE_NEURONS_PER_DAY,
          message,
          ...(missing ? { setup: MissingUsageConfiguration.setup } : {}),
        },
        headers,
      );
    }
  }

  private buildUsageClient(): { fetch: () => Promise<unknown> } {
    if (this.deps.usageClientFactory) return this.deps.usageClientFactory();
    const { settings } = this.deps;
    if (!settings.usageConfigured) return new MissingUsageConfiguration();
    return new UsageClient({
      accountId: settings.analyticsAccountId ?? "",
      token: settings.analyticsToken ?? "",
      days: settings.usageDays,
    });
  }

  private sessionPayload(requestId: string): Record<string, unknown> {
    const { settings } = this.deps;
    return {
      ok: true,
      request_id: requestId,
      model: settings.model,
      gateway: settings.gatewayId,
      limits: {
        max_text_chars: settings.maxTextChars,
        chunk_chars: settings.chunkChars,
        max_concurrency: settings.maxConcurrency,
        max_output_tokens: settings.maxOutputTokens,
      },
      features: {
        usage_analytics: settings.usageConfigured,
        gateway_cache_ttl: settings.gatewayCacheTtl,
        streaming: true,
      },
    };
  }

  private modelsPayload(): Record<string, unknown> {
    return { default: this.deps.settings.model, data: this.deps.catalog.list() };
  }

  private health(): Record<string, unknown> {
    const { settings } = this.deps;
    return {
      status: "ok",
      service: "trans",
      model: settings.model,
      gateway: settings.gatewayId,
      tracing: { worker_traces: true, ai_gateway_logs: settings.gatewayCollectLogs },
    };
  }

  private errorBody(error: ApiError, path: string, requestId: string): Record<string, unknown> {
    const openAiScoped = path.startsWith("/v1/") || path.includes("/chat/") || path.endsWith("/models");
    return openAiScoped ? this.formatter.error(error, requestId) : legacyErrorPayload(error, requestId);
  }

  private corsHeaders(origin: string | null, requestId: string): Record<string, string> {
    const allowed = this.deps.settings.allowedOrigins;
    const allowOrigin = allowed.includes("*") ? "*" : origin && allowed.includes(origin) ? origin : allowed[0] ?? "*";
    return {
      "access-control-allow-origin": allowOrigin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, x-api-key, x-request-id",
      "access-control-max-age": "86400",
      vary: "origin",
      "x-request-id": requestId,
    };
  }

  private requestId(request: Request): string {
    const supplied = request.headers.get("x-request-id")?.trim();
    if (supplied) return supplied.slice(0, 64);
    const ray = request.headers.get("cf-ray")?.trim();
    if (ray) return ray.slice(0, 64);
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_TYPE, ...headers },
  });
}

async function readJson(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_BODY_BYTES) {
    throw payloadTooLarge("Request body is larger than 2 MB.");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw payloadTooLarge("Request body is larger than 2 MB.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("Request body must be valid JSON.", { code: "invalid_request", status: 400 });
  }
}
