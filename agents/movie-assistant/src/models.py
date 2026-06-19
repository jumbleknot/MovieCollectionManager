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

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

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


def runtime_env(
    agent_config: Mapping[str, Any] | None, base: Mapping[str, str] | None = None
) -> Mapping[str, str]:
    """Overlay a per-run agent config onto the base env for model selection (018 US2, research R8).

    Maps the BFF's resolved `ResolvedRunConfig` fields (provider / ollamaBaseUrl / anthropicKey)
    onto the env keys `select_model_config` + `build_chat_model` already read (MODEL_PROVIDER /
    OLLAMA_BASE_URL / ANTHROPIC_API_KEY). Only the *source* of the mapping changes (per-run config
    vs `os.environ`) — the pure selection signatures are untouched, so the golden harness is
    unaffected. No agent config → the base env is returned unchanged (SC-002/SC-005: the shared-env
    behaviour is preserved only when no per-user config is present, which the BFF gate prevents at
    runtime). The base mapping is never mutated.
    """
    base = os.environ if base is None else base
    if not agent_config:
        return base
    overlay = dict(base)
    provider = agent_config.get("provider")
    if provider:
        provider = str(provider)
        if provider != (base.get("MODEL_PROVIDER") or "ollama"):
            # Per-node model ids are provider-specific (e.g. the Ollama default `qwen2.5:32b` is
            # not a valid Anthropic model id). On a provider switch, drop the base env's per-node
            # model pins so the NEW provider's built-in defaults apply — otherwise an Anthropic
            # user inherits the gateway's `SPECIALIST_MODEL=qwen2.5:32b` and every Claude call
            # 404s on an unknown model (018 review #1). ESCALATION_MODEL is always Anthropic, so
            # dropping it just reverts to the frontier default.
            for pinned in ("SUPERVISOR_MODEL", "SPECIALIST_MODEL", "ESCALATION_MODEL"):
                overlay.pop(pinned, None)
        overlay["MODEL_PROVIDER"] = provider
    if agent_config.get("ollamaBaseUrl"):
        overlay["OLLAMA_BASE_URL"] = str(agent_config["ollamaBaseUrl"])
    if agent_config.get("anthropicKey"):
        overlay["ANTHROPIC_API_KEY"] = str(agent_config["anthropicKey"])
    else:
        # No per-user Anthropic key in this run → NEVER fall back to a shared process-env key.
        # A per-user run must use only the user's own credentials, so an Ollama-only user can
        # never reach the always-Claude escalation tier on the org's shared key (018 review #7).
        overlay.pop("ANTHROPIC_API_KEY", None)
    return overlay


def escalation_or_base(env: Mapping[str, str]) -> ModelSpec:
    """Resolve the escalation spec, degrading to the base specialist without an Anthropic key (R10).

    The escalation tier is always Claude frontier — unusable for a user who supplied only Ollama
    credentials. When no `ANTHROPIC_API_KEY` is present in the per-run env, fall back to the base
    balanced specialist so an escalation never makes an unauthenticated/failing Claude call.
    """
    if not (env.get("ANTHROPIC_API_KEY") or "").strip():
        return select_model_config("organizer", env)
    return select_model_config("escalation", env)


def resolve_anthropic_key(env: Mapping[str, str]) -> str | None:
    """Resolve the Anthropic API key for a run — the per-run key only, no shared fallback (FR-021).

    `runtime_env` injects the requesting user's key into `env["ANTHROPIC_API_KEY"]` for the run;
    that per-run value is the SOLE source. There is deliberately NO Vault/operator fallback (a
    shared model key would defeat the per-user-credentials design, and `runtime_env` already drops
    any ambient `ANTHROPIC_API_KEY` for a run that carries no user key). Returns None when absent,
    so an Anthropic build with no per-user key fails closed rather than spending a shared key.
    """
    return (env.get("ANTHROPIC_API_KEY") or "").strip() or None


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

        return ChatAnthropic(  # type: ignore[call-arg]
            model=spec.model_id,
            temperature=spec.temperature,
            api_key=resolve_anthropic_key(env),  # type: ignore[arg-type]
        )

    raise ValueError(f"unknown model provider: {spec.provider!r}")
