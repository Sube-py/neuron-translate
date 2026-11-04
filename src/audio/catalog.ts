/** Curated text-to-speech models with pricing so the UI can compare them. */

export interface TtsModel {
  id: string;
  label: string;
  note: string;
  /** Field the model expects for the text input. */
  inputField: "prompt" | "text";
  /** Language codes accepted by the model, empty when it is fixed. */
  languages: string[];
  voices: string[];
  defaultVoice: string | null;
  /** Estimated neurons per 1,000 characters, derived from unit pricing. */
  neuronsPer1kChars: number;
  priceLabel: string;
}

export const TTS_CATALOG: TtsModel[] = [
  {
    id: "@cf/myshell-ai/melotts",
    label: "MeloTTS (多语言)",
    note: "最便宜、最快，支持中英日韩等；输出 WAV（体积偏大），无音色可选",
    inputField: "prompt",
    languages: ["en", "zh", "ja", "ko", "fr", "es", "it", "pt"],
    voices: [],
    defaultVoice: null,
    // $0.000205 per audio minute ≈ 18.63 neurons; ~900 chars ≈ 1 minute.
    neuronsPer1kChars: 20.7,
    priceLabel: "$0.000205 / 音频分钟",
  },
  {
    id: "@cf/deepgram/aura-1",
    label: "Deepgram Aura-1",
    note: "自然、有停顿和语气词，12 种音色；比 MeloTTS 贵约 60 倍",
    inputField: "text",
    languages: [],
    voices: [
      "angus",
      "asteria",
      "arcas",
      "orion",
      "orpheus",
      "athena",
      "luna",
      "zeus",
      "perseus",
      "helios",
      "hera",
      "stella",
    ],
    defaultVoice: "luna",
    neuronsPer1kChars: 1363.64,
    priceLabel: "$0.015 / 1k 字符",
  },
  {
    id: "@cf/deepgram/aura-2-en",
    label: "Deepgram Aura-2 (EN)",
    note: "最新一代，40 种音色，英文最佳；最贵",
    inputField: "text",
    languages: [],
    voices: [
      "amalthea",
      "andromeda",
      "apollo",
      "arcas",
      "aries",
      "asteria",
      "athena",
      "atlas",
      "aurora",
      "callista",
      "cora",
      "cordelia",
      "delia",
      "draco",
      "electra",
      "harmonia",
      "helena",
      "hera",
      "hermes",
      "hyperion",
      "iris",
      "janus",
      "juno",
      "jupiter",
      "luna",
      "mars",
      "minerva",
      "neptune",
      "odysseus",
      "ophelia",
      "orion",
      "orpheus",
      "pandora",
      "phoebe",
      "pluto",
      "saturn",
      "thalia",
      "theia",
      "vesta",
      "zeus",
    ],
    defaultVoice: "luna",
    neuronsPer1kChars: 2727,
    priceLabel: "$0.030 / 1k 字符",
  },
];

export class TtsCatalog {
  private readonly byName = new Map<string, TtsModel>();

  constructor(models: TtsModel[] = TTS_CATALOG) {
    this.models = models;
    for (const model of models) {
      this.byName.set(model.id, model);
      this.byName.set(model.id.replace("@cf/", ""), model);
      this.byName.set(model.id.split("/").pop() ?? model.id, model);
    }
  }

  readonly models: TtsModel[];

  list(): Array<Record<string, unknown>> {
    return this.models.map((model) => ({
      id: model.id,
      label: model.label,
      note: model.note,
      languages: model.languages,
      voices: model.voices,
      default_voice: model.defaultVoice,
      price: model.priceLabel,
      neurons_per_1k_chars: model.neuronsPer1kChars,
    }));
  }

  find(requested: string | null | undefined): TtsModel | null {
    if (!requested) return null;
    return this.byName.get(requested.trim()) ?? null;
  }

  get defaultModel(): TtsModel {
    return this.models[0] as TtsModel;
  }
}

export function estimateNeurons(model: TtsModel, characters: number): number {
  return Math.round((model.neuronsPer1kChars * characters) / 1000 * 100) / 100;
}
