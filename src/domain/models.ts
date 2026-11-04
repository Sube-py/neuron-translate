/** Domain types shared by the translation and chat use cases. */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export const EMPTY_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0 };

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
  };
}

export function usagePayload(usage: TokenUsage): Record<string, number> {
  return {
    prompt: usage.promptTokens,
    completion: usage.completionTokens,
    total: usage.promptTokens + usage.completionTokens,
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: string;
}

export type Metadata = Record<string, string | number | boolean>;

export interface TranslationRequest {
  text: string;
  targetLang: string;
  sourceLang: string;
  tone: string | null;
  glossary: Record<string, string>;
  preserveFormatting: boolean;
  model: string | null;
}

export interface TextChunk {
  text: string;
  separator: string;
}

export interface TranslationResult {
  text: string;
  chunkCount: number;
  cachedChunks: number;
  model: string;
  gatewayId: string;
  usage: TokenUsage;
  durationMs: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string | null;
  stream: boolean;
  includeUsage: boolean;
  temperature: number | null;
  maxTokens: number | null;
  tone: string | null;
  targetLang: string | null;
  glossary: Record<string, string>;
}

export interface ChatResult {
  text: string;
  model: string;
  usage: TokenUsage;
  durationMs: number;
}

export interface ChatOutcome {
  result: ChatResult;
  stream: boolean;
  includeUsage: boolean;
  requestedModel: string | null;
}
