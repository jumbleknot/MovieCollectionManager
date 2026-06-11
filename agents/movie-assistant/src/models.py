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
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from langchain_core.language_models.chat_models import BaseChatModel

    from src.eval.cassette import ChatModel

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

    if node in ("curator", "organizer", "query"):
        model_id = env.get("SPECIALIST_MODEL") or _BALANCED_DEFAULTS[provider]
        return ModelSpec(provider=provider, model_id=model_id, temperature=0.0)

    if node == "escalation":
        # Frontier escape hatch is always Claude, regardless of the base provider (research R1).
        model_id = env.get("ESCALATION_MODEL") or _ESCALATION_DEFAULT
        return ModelSpec(provider="anthropic", model_id=model_id, temperature=0.0)

    raise ValueError(f"unknown graph node: {node!r}")


def frontier_escalation_enabled(env: Mapping[str, str]) -> bool:
    """Whether the always-Claude frontier escalation tier is permitted (off by default).

    Backed by the flag provider (T075b, research R16): Unleash when UNLEASH_URL is set,
    else default-off (no pre-existing env flag for this feature). When UNLEASH_URL is
    unset the escalation tier remains a latent escape hatch — no runtime caller routes
    there until this returns True.
    """
    from src.flags import FRONTIER_ESCALATION, get_flag_provider

    return get_flag_provider(env).enabled(FRONTIER_ESCALATION)


def build_chat_model(spec: ModelSpec, env: Mapping[str, str] | None = None) -> "ChatModel":
    """Instantiate a chat model from a ModelSpec, honoring the cassette mode.

    LLM_CASSETTE_MODE=replay returns a ReplayChatModel (no provider import / no key);
    =record wraps the real model and persists responses; unset returns the real model.
    The active cassette (record/replay) is supplied by `cassette.use(...)` (research R13).
    """
    import os

    env = os.environ if env is None else env
    mode = (env.get("LLM_CASSETTE_MODE") or "").strip().lower()
    if mode in ("record", "replay"):
        from src.eval.cassette import RecordingChatModel, ReplayChatModel, active_cassette

        cassette = active_cassette()
        if mode == "replay":
            return ReplayChatModel(cassette, spec.model_id)
        return RecordingChatModel(_build_real_chat_model(spec, env), cassette, spec.model_id)
    return _build_real_chat_model(spec, env)


def _build_real_chat_model(spec: ModelSpec, env: Mapping[str, str]) -> "BaseChatModel":
    """Instantiate the actual provider model (the pre-cassette body of build_chat_model).

    Lazy-imports the provider package so `select_model_config` stays dependency-free.
    Ollama reads OLLAMA_BASE_URL; Anthropic reads ANTHROPIC_API_KEY.
    """
    if spec.provider == "ollama":
        from langchain_ollama import ChatOllama

        return ChatOllama(
            model=spec.model_id,
            temperature=spec.temperature,
            base_url=env.get("OLLAMA_BASE_URL") or "http://localhost:11434",
        )

    if spec.provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        from src.secrets import resolve_secret

        return ChatAnthropic(  # type: ignore[call-arg]
            model=spec.model_id,
            temperature=spec.temperature,
            # Vault-injected in deployed environments, env (.env.local) in dev (T030a).
            api_key=resolve_secret("ANTHROPIC_API_KEY", env),  # type: ignore[arg-type]
        )

    raise ValueError(f"unknown model provider: {spec.provider!r}")
