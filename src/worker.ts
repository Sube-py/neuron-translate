/** Worker entry point: wiring, static assets and the API adapter. */

import { ChatService } from "./chat/service.js";
import type { Settings } from "./config/settings.js";
import { loadSettings, type Env } from "./config/settings.js";
import { HttpApp } from "./http/router.js";
import { Logger } from "./observability/logger.js";
import { ModelCatalog } from "./provider/catalog.js";
import { WorkersAiProvider } from "./provider/workersAi.js";
import { TextChunker } from "./translate/chunker.js";
import { TranslationService } from "./translate/service.js";

function buildApp(env: Env, settings: Settings): { app: HttpApp; logger: Logger } {
  const logger = new Logger();
  const provider = new WorkersAiProvider(env.AI, settings.model, {
    gatewayId: settings.gatewayId,
    temperature: settings.temperature,
    maxOutputTokens: settings.maxOutputTokens,
    cacheTtl: settings.gatewayCacheTtl,
    collectLogs: settings.gatewayCollectLogs,
  });
  const catalog = new ModelCatalog(settings.model);
  const translation = new TranslationService(provider, new TextChunker(settings.chunkChars), {
    maxConcurrency: settings.maxConcurrency,
    maxOutputTokens: settings.maxOutputTokens,
  });
  const chat = new ChatService(provider, catalog, settings.model);

  return {
    logger,
    app: new HttpApp({ settings, provider, translation, chat, catalog, logger }),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!HttpApp.isApiPath(url.pathname || "/")) {
      return env.ASSETS.fetch(request);
    }

    const settings = loadSettings(env);
    const { app } = buildApp(env, settings);
    return app.handle(request);
  },
} satisfies ExportedHandler<Env>;
