/** Validation for the JSON payload accepted by `POST /translate`. */

import type { TranslationRequest } from "../domain/models.js";
import { invalidRequest } from "../http/errors.js";

const HARD_TEXT_LIMIT = 200_000;
const MAX_LANG_CHARS = 20;
const MAX_TONE_CHARS = 120;
const MAX_GLOSSARY_ENTRIES = 50;
const MAX_GLOSSARY_TERM_CHARS = 200;
const MAX_MODEL_CHARS = 120;

export class TranslationRequestParser {
  private readonly maxTextChars: number;

  constructor(maxTextChars = 20_000) {
    this.maxTextChars = Math.min(maxTextChars, HARD_TEXT_LIMIT);
  }

  parse(payload: unknown): TranslationRequest {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw invalidRequest("Request body must be a JSON object.");
    }
    const body = payload as Record<string, unknown>;

    return {
      text: this.text(body),
      targetLang: this.lang(body, "target_lang", "en"),
      sourceLang: this.lang(body, "source_lang", "auto"),
      tone: this.tone(body),
      glossary: this.glossary(body),
      preserveFormatting: this.bool(body, "preserve_formatting", true),
      model: this.model(body),
    };
  }

  private text(body: Record<string, unknown>): string {
    const raw = body.text;
    if (typeof raw !== "string" || raw.trim() === "") {
      throw invalidRequest("Field 'text' is required and must be a non-empty string.", "text");
    }
    if (raw.length > this.maxTextChars) {
      throw invalidRequest(`Field 'text' exceeds the ${this.maxTextChars} character limit.`, "text");
    }
    return raw;
  }

  private lang(body: Record<string, unknown>, field: string, fallback: string): string {
    const raw = body[field];
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "string") throw invalidRequest(`Field '${field}' must be a string.`, field);
    const code = raw.trim() || fallback;
    if (code.length > MAX_LANG_CHARS) {
      throw invalidRequest(`Field '${field}' must be at most ${MAX_LANG_CHARS} characters.`, field);
    }
    return code;
  }

  private tone(body: Record<string, unknown>): string | null {
    const raw = body.tone;
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") throw invalidRequest("Field 'tone' must be a string.", "tone");
    const tone = raw.trim();
    if (!tone) return null;
    if (tone.length > MAX_TONE_CHARS) {
      throw invalidRequest(`Field 'tone' must be at most ${MAX_TONE_CHARS} characters.`, "tone");
    }
    return tone;
  }

  private glossary(body: Record<string, unknown>): Record<string, string> {
    const raw = body.glossary;
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw invalidRequest("Field 'glossary' must be an object of source term to translation.", "glossary");
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > MAX_GLOSSARY_ENTRIES) {
      throw invalidRequest(`Field 'glossary' supports at most ${MAX_GLOSSARY_ENTRIES} entries.`, "glossary");
    }

    const glossary: Record<string, string> = {};
    for (const [term, translated] of entries) {
      if (typeof translated !== "string") {
        throw invalidRequest("Glossary keys and values must be strings.", "glossary");
      }
      const cleanTerm = term.trim();
      const cleanTranslated = translated.trim();
      if (!cleanTerm || !cleanTranslated) {
        throw invalidRequest("Glossary entries cannot be empty.", "glossary");
      }
      if (cleanTerm.length > MAX_GLOSSARY_TERM_CHARS) {
        throw invalidRequest(
          `Glossary terms must be at most ${MAX_GLOSSARY_TERM_CHARS} characters.`,
          "glossary",
        );
      }
      glossary[cleanTerm] = cleanTranslated;
    }
    return glossary;
  }

  private bool(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
    const raw = body[field];
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "boolean") throw invalidRequest(`Field '${field}' must be a boolean.`, field);
    return raw;
  }

  private model(body: Record<string, unknown>): string | null {
    const raw = body.model;
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") throw invalidRequest("Field 'model' must be a string.", "model");
    const candidate = raw.trim();
    if (!candidate) return null;
    if (candidate.length > MAX_MODEL_CHARS) throw invalidRequest("Field 'model' is too long.", "model");
    return candidate;
  }
}
