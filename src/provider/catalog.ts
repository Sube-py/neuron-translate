/** Curated list of Workers AI models that are known to work for translation. */

export interface ModelOption {
  id: string;
  label: string;
  note: string;
  reasoning: boolean;
}

const CATALOG: ModelOption[] = [
  {
    id: "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
    label: "Llama 3.1 8B (fast)",
    note: "默认 · 快且便宜，免费额度约 9,000 次/天",
    reasoning: false,
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B",
    note: "质量最好，约 1,500 次/天",
    reasoning: false,
  },
  {
    id: "@cf/ibm-granite/granite-4.0-h-micro",
    label: "Granite 4.0 Micro",
    note: "最省 neurons，适合短句",
    reasoning: false,
  },
  {
    id: "@cf/zai-org/glm-4.7-flash",
    label: "GLM-4.7 Flash",
    note: "reasoning：思考会占用输出预算，较慢",
    reasoning: true,
  },
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    label: "Gemma 4 26B",
    note: "reasoning：质量稳，速度中等",
    reasoning: true,
  },
  {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    label: "Qwen3 30B A3B",
    note: "reasoning：多语言强，token 消耗高",
    reasoning: true,
  },
  {
    id: "@cf/openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    note: "reasoning：最大最贵，慢",
    reasoning: true,
  },
];

export class ModelCatalog {
  private readonly options: ModelOption[];
  private readonly byName = new Map<string, string>();

  constructor(private readonly defaultModel: string) {
    this.options = [...CATALOG];
    if (!this.options.some((option) => option.id === defaultModel)) {
      this.options.unshift({
        id: defaultModel,
        label: defaultModel,
        note: "当前部署默认模型",
        reasoning: false,
      });
    }
    for (const option of this.options) {
      this.byName.set(option.id, option.id);
      this.byName.set(option.id.replace("@cf/", ""), option.id);
      this.byName.set(option.id.split("/").pop() ?? option.id, option.id);
    }
  }

  list(): ModelOption[] {
    return this.options.map((option) => ({ ...option }));
  }

  ids(): string[] {
    return this.options.map((option) => option.id);
  }

  /** Accepts a full id, `meta/llama-...` or a bare catalog name. */
  resolve(requested: string | null | undefined): string | null {
    if (!requested) return null;
    const candidate = requested.trim();
    if (!candidate) return null;
    return this.byName.get(candidate) ?? candidate;
  }

  get fallback(): string {
    return this.defaultModel;
  }
}
