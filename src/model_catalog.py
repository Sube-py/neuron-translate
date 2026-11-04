"""Curated list of Workers AI models that are known to work for translation."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ModelOption:
    model_id: str
    label: str
    note: str
    reasoning: bool = False

    def to_payload(self) -> dict[str, object]:
        return {
            "id": self.model_id,
            "label": self.label,
            "note": self.note,
            "reasoning": self.reasoning,
        }


CATALOG: tuple[ModelOption, ...] = (
    ModelOption(
        "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
        "Llama 3.1 8B (fast)",
        "默认 · 快且便宜，免费额度约 9,000 次/天",
    ),
    ModelOption(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "Llama 3.3 70B",
        "质量最好，约 1,500 次/天",
    ),
    ModelOption(
        "@cf/ibm-granite/granite-4.0-h-micro",
        "Granite 4.0 Micro",
        "最省 neurons，适合短句",
    ),
    ModelOption(
        "@cf/zai-org/glm-4.7-flash",
        "GLM-4.7 Flash",
        "reasoning：思考会占用输出预算，较慢",
        reasoning=True,
    ),
    ModelOption(
        "@cf/google/gemma-4-26b-a4b-it",
        "Gemma 4 26B",
        "reasoning：质量稳，速度中等",
        reasoning=True,
    ),
    ModelOption(
        "@cf/qwen/qwen3-30b-a3b-fp8",
        "Qwen3 30B A3B",
        "reasoning：多语言强，token 消耗高",
        reasoning=True,
    ),
    ModelOption(
        "@cf/openai/gpt-oss-120b",
        "GPT-OSS 120B",
        "reasoning：最大最贵，慢",
        reasoning=True,
    ),
)


class ModelCatalog:
    """Resolves model ids coming from clients onto the curated catalog."""

    def __init__(self, default_model: str) -> None:
        self._options = list(CATALOG)
        if all(option.model_id != default_model for option in self._options):
            self._options.insert(
                0,
                ModelOption(default_model, default_model, "当前部署默认模型"),
            )
        self._by_name: dict[str, str] = {}
        for option in self._options:
            self._by_name[option.model_id] = option.model_id
            self._by_name[option.model_id.removeprefix("@cf/")] = option.model_id
            self._by_name[option.model_id.rsplit("/", 1)[-1]] = option.model_id

    def options(self) -> list[dict[str, object]]:
        return [option.to_payload() for option in self._options]

    def ids(self) -> list[str]:
        return [option.model_id for option in self._options]

    def resolve(self, requested: str | None) -> str | None:
        """Accept a full id, ``meta/llama-...`` or a bare catalog name."""
        if not requested:
            return None
        candidate = requested.strip()
        if not candidate:
            return None
        return self._by_name.get(candidate, candidate)
