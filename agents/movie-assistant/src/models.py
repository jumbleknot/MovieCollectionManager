"""Provider-abstracted, env-configured model selection.

Implements: T016. Decision: research.md R1.
Default provider is self-hosted Ollama; Anthropic Claude is the documented fallback,
selected per graph node via MODEL_PROVIDER + per-node model env vars. Safety-relevant
nodes use low temperature. The escalation tier is always Claude frontier regardless of
the base provider.

`select_model_config` is PURE (env -> ModelSpec) so it is unit-testable without any LLM
dependency. Instantiating the LangChain chat model from a ModelSpec (build_chat_model)
is a thin adapter added when the graph wiring (T020) requires it.
"""

from collections.abc import Mapping
from dataclasses import dataclass

_FAST_DEFAULTS = {"ollama": "qwen2.5", "anthropic": "claude-haiku-4-5"}
_BALANCED_DEFAULTS = {"ollama": "qwen2.5:32b", "anthropic": "claude-sonnet-4-6"}
_ESCALATION_DEFAULT = "claude-opus-4-8"


@dataclass(frozen=True)
class ModelSpec:
    """A resolved model choice for one graph node — provider-agnostic at the call site."""

    provider: str
    model_id: str
    temperature: float


def select_model_config(node: str, env: Mapping[str, str]) -> ModelSpec:
    """Resolve the model for a graph node from the environment.

    Default provider is Ollama; MODEL_PROVIDER=anthropic switches to the Claude fallback.
    The escalation tier is always Claude frontier. Per-node env vars override the defaults.
    """
    provider = env.get("MODEL_PROVIDER") or "ollama"

    if node == "supervisor":
        model_id = env.get("SUPERVISOR_MODEL") or _FAST_DEFAULTS[provider]
        return ModelSpec(provider=provider, model_id=model_id, temperature=0.0)

    if node in ("curator", "organizer"):
        model_id = env.get("SPECIALIST_MODEL") or _BALANCED_DEFAULTS[provider]
        return ModelSpec(provider=provider, model_id=model_id, temperature=0.0)

    if node == "escalation":
        # Frontier escape hatch is always Claude, regardless of the base provider (research R1).
        model_id = env.get("ESCALATION_MODEL") or _ESCALATION_DEFAULT
        return ModelSpec(provider="anthropic", model_id=model_id, temperature=0.0)

    raise ValueError(f"unknown graph node: {node!r}")
