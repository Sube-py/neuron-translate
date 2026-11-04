/** Validation for text-to-speech requests (OpenAI `/v1/audio/speech` shape). */

import { invalidRequest } from "../http/errors.js";
import type { TtsCatalog, TtsModel } from "./catalog.js";

const MAX_CHARS = 5_000;
const MAX_LANG_CHARS = 10;

export interface SpeechRequest {
  text: string;
  model: TtsModel;
  voice: string | null;
  lang: string | null;
}

export class SpeechRequestParser {
  constructor(
    private readonly catalog: TtsCatalog,
    private readonly maxChars = MAX_CHARS,
  ) {}

  parse(payload: unknown): SpeechRequest {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw invalidRequest("Request body must be a JSON object.");
    }
    const body = payload as Record<string, unknown>;
    const model = this.resolveModel(body.model);

    return {
      text: this.text(body, model),
      model,
      voice: this.voice(body, model),
      lang: this.lang(body, model),
    };
  }

  private resolveModel(raw: unknown): TtsModel {
    if (raw === undefined || raw === null || raw === "") return this.catalog.defaultModel;
    if (typeof raw !== "string") throw invalidRequest("Field 'model' must be a string.", "model");
    const model = this.catalog.find(raw);
    if (!model) {
      throw invalidRequest(
        `Unknown speech model '${raw}'. Use GET /api/models?kind=tts to list them.`,
        "model",
      );
    }
    return model;
  }

  private text(body: Record<string, unknown>, model: TtsModel): string {
    const raw = body.input ?? body.text ?? body.prompt;
    if (typeof raw !== "string" || raw.trim() === "") {
      throw invalidRequest("Field 'input' is required and must be a non-empty string.", "input");
    }
    if (raw.length > this.maxChars) {
      throw invalidRequest(`Field 'input' exceeds the ${this.maxChars} character limit.`, "input");
    }
    if (model.inputField === "text" && /[^\x00-\x7F]/.test(raw) && model.id.endsWith("-en")) {
      throw invalidRequest(
        `${model.label} 只支持英文，换成 MeltTTS 或 aura-1 处理其他语言。`,
        "input",
      );
    }
    return raw;
  }

  private voice(body: Record<string, unknown>, model: TtsModel): string | null {
    const raw = body.voice ?? body.speaker;
    if (model.voices.length === 0) return null;
    if (typeof raw !== "string" || raw.trim() === "") return model.defaultVoice;
    const voice = raw.trim().toLowerCase();
    if (!model.voices.includes(voice)) {
      throw invalidRequest(
        `Voice '${voice}' is not supported by ${model.label}. Options: ${model.voices.join(", ")}.`,
        "voice",
      );
    }
    return voice;
  }

  private lang(body: Record<string, unknown>, model: TtsModel): string | null {
    if (model.languages.length === 0) return null;
    const raw = body.lang ?? body.language;
    if (typeof raw !== "string" || raw.trim() === "") return model.languages[0] ?? null;
    const lang = raw.trim().toLowerCase().slice(0, MAX_LANG_CHARS);
    if (!model.languages.includes(lang)) {
      throw invalidRequest(
        `Language '${lang}' is not supported by ${model.label}. Options: ${model.languages.join(", ")}.`,
        "lang",
      );
    }
    return lang;
  }
}
