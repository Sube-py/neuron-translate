/** Runtime configuration parsed from Worker vars and secrets. */

export const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
export const DEFAULT_GATEWAY = "default";

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  TRANSLATION_MODEL?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_CACHE_TTL?: string;
  AI_GATEWAY_COLLECT_LOGS?: string;
  TRANSLATION_CHUNK_CHARS?: string;
  TRANSLATION_MAX_TEXT_CHARS?: string;
  TRANSLATION_MAX_OUTPUT_TOKENS?: string;
  TRANSLATION_TEMPERATURE?: string;
  TRANSLATION_MAX_CONCURRENCY?: string;
  CORS_ALLOWED_ORIGINS?: string;
  TRANSLATION_API_TOKEN?: string;
  ANALYTICS_ACCOUNT_ID?: string;
  ANALYTICS_API_TOKEN?: string;
  USAGE_DAYS?: string;
}

export interface Settings {
  model: string;
  gatewayId: string;
  gatewayCacheTtl: number;
  gatewayCollectLogs: boolean;
  temperature: number;
  maxOutputTokens: number | null;
  chunkChars: number;
  maxTextChars: number;
  maxConcurrency: number;
  apiToken: string | null;
  allowedOrigins: string[];
  analyticsAccountId: string | null;
  analyticsToken: string | null;
  usageDays: number;
  usageConfigured: boolean;
}

const EMPTY = new Set(["", "undefined", "null", "none"]);

function read(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  return EMPTY.has(text.toLowerCase()) ? null : text;
}

function readInt(raw: string | undefined, fallback: number, min?: number, max?: number): number {
  const text = read(raw);
  if (text === null) return fallback;
  const value = Number.parseInt(text, 10);
  if (Number.isNaN(value)) return fallback;
  return clamp(value, min, max);
}

function readFloat(raw: string | undefined, fallback: number, min?: number, max?: number): number {
  const text = read(raw);
  if (text === null) return fallback;
  const value = Number.parseFloat(text);
  if (Number.isNaN(value)) return fallback;
  return clamp(value, min, max);
}

function clamp(value: number, min?: number, max?: number): number {
  let result = value;
  if (min !== undefined) result = Math.max(result, min);
  if (max !== undefined) result = Math.min(result, max);
  return result;
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
  const text = read(raw);
  if (text === null) return fallback;
  return ["1", "true", "yes", "on"].includes(text.toLowerCase());
}

function readList(raw: string | undefined, fallback: string[]): string[] {
  const text = read(raw);
  if (text === null) return fallback;
  const values = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

export function loadSettings(env: Env): Settings {
  const analyticsAccountId = read(env.ANALYTICS_ACCOUNT_ID);
  const analyticsToken = read(env.ANALYTICS_API_TOKEN);
  const maxOutputTokens = readInt(env.TRANSLATION_MAX_OUTPUT_TOKENS, 2048, 64);

  return {
    model: read(env.TRANSLATION_MODEL) ?? DEFAULT_MODEL,
    gatewayId: read(env.AI_GATEWAY_ID) ?? DEFAULT_GATEWAY,
    gatewayCacheTtl: readInt(env.AI_GATEWAY_CACHE_TTL, 0, 0),
    gatewayCollectLogs: readBool(env.AI_GATEWAY_COLLECT_LOGS, true),
    temperature: readFloat(env.TRANSLATION_TEMPERATURE, 0.1, 0, 2),
    maxOutputTokens,
    chunkChars: readInt(env.TRANSLATION_CHUNK_CHARS, 3000, 500, 20000),
    maxTextChars: readInt(env.TRANSLATION_MAX_TEXT_CHARS, 20000, 500),
    maxConcurrency: readInt(env.TRANSLATION_MAX_CONCURRENCY, 4, 1, 8),
    apiToken: read(env.TRANSLATION_API_TOKEN),
    allowedOrigins: readList(env.CORS_ALLOWED_ORIGINS, ["*"]),
    analyticsAccountId,
    analyticsToken,
    usageDays: readInt(env.USAGE_DAYS, 7, 1, 7),
    usageConfigured: Boolean(analyticsAccountId && analyticsToken),
  };
}
