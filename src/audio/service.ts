/** Text-to-speech service on top of the Workers AI binding. */

import { upstreamError } from "../http/errors.js";
import { estimateNeurons, type TtsModel } from "./catalog.js";
import type { SpeechRequest } from "./validation.js";

export interface SpeechResult {
  audio: ArrayBuffer;
  contentType: string;
  model: string;
  characters: number;
  estimatedNeurons: number;
  durationMs: number;
}

const DEFAULT_CONTENT_TYPE = "audio/mpeg";

export class SpeechService {
  constructor(private readonly binding: Ai) {}

  async synthesize(request: SpeechRequest): Promise<SpeechResult> {
    const started = Date.now();
    const inputs = this.inputs(request);
    const options = request.model.id.startsWith("@cf/deepgram/") ? { returnRawResponse: true } : undefined;

    let raw: unknown;
    try {
      raw = await this.binding.run(request.model.id, inputs as never, options as never);
    } catch (error) {
      throw upstreamError(`Text-to-speech failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const { audio, contentType } = await toAudio(raw);
    if (audio.byteLength === 0) throw upstreamError("Text-to-speech returned no audio.");

    return {
      audio,
      contentType,
      model: request.model.id,
      characters: request.text.length,
      estimatedNeurons: estimateNeurons(request.model, request.text.length),
      durationMs: Date.now() - started,
    };
  }

  private inputs(request: SpeechRequest): Record<string, unknown> {
    const model: TtsModel = request.model;
    if (model.inputField === "prompt") {
      return { prompt: request.text, lang: request.lang ?? model.languages[0] ?? "en" };
    }
    return {
      text: request.text,
      speaker: request.voice ?? model.defaultVoice ?? undefined,
      encoding: "mp3",
    };
  }
}

export function contentTypeOf(audio: ArrayBuffer): string {
  const bytes = new Uint8Array(audio.slice(0, 12));
  const magic = (offset: number, length: number) =>
    String.fromCharCode(...Array.from(bytes.slice(offset, offset + length)));

  if (magic(0, 4) === "RIFF") return "audio/wav";
  if (magic(0, 4) === "OggS") return "audio/ogg";
  if (magic(0, 4) === "fLaC") return "audio/flac";
  if (magic(0, 3) === "ID3") return "audio/mpeg";
  // MPEG frame sync: 11 set bits.
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if (first === 0xff && (second & 0xe0) === 0xe0) return "audio/mpeg";
  return DEFAULT_CONTENT_TYPE;
}

async function toAudio(raw: unknown): Promise<{ audio: ArrayBuffer; contentType: string }> {
  const sniffed = await readAudio(raw);
  return { audio: sniffed.audio, contentType: contentTypeOf(sniffed.audio) };
}

async function readAudio(raw: unknown): Promise<{ audio: ArrayBuffer; contentType: string }> {
  if (raw instanceof Response) {
    return {
      audio: await raw.arrayBuffer(),
      contentType: raw.headers.get("content-type") ?? DEFAULT_CONTENT_TYPE,
    };
  }
  if (raw instanceof ReadableStream) {
    const response = new Response(raw);
    return {
      audio: await response.arrayBuffer(),
      contentType: response.headers.get("content-type") ?? DEFAULT_CONTENT_TYPE,
    };
  }
  if (raw instanceof ArrayBuffer) return { audio: raw, contentType: DEFAULT_CONTENT_TYPE };
  if (ArrayBuffer.isView(raw)) {
    return {
      audio: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
      contentType: DEFAULT_CONTENT_TYPE,
    };
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    for (const key of ["audio", "audio_base64", "data"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return { audio: base64ToBytes(value), contentType: DEFAULT_CONTENT_TYPE };
      }
      if (value instanceof ArrayBuffer) return { audio: value, contentType: DEFAULT_CONTENT_TYPE };
    }
  }
  throw upstreamError("Text-to-speech returned an unexpected payload.");
}

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
