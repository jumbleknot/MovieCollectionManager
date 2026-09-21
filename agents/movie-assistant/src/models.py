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

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from langchain_core.language_models.chat_models import BaseChatModel

    from src.eval.cassette import ChatModel

_FAST_DEFAULTS = {"ollama": "qwen2.5", "anthropic": "claude-haiku-4-5"}
_BALANCED_DEFAULTS = {"ollama": "qwen2.5:32b", "anthropic": "claude-sonnet-5"}
# The specialist tier moved 4.6 -> 5 for cost: $2/$10 per MTok against $3/$15, a straight -33% on
# extraction. The three extraction prompts are 120-520 tokens returning a small JSON object, far
# too short to cache under any model (the smallest cacheable prefix is 1,024 tokens), so price per
# token is the only lever. This is a CODE DEFAULT, which is what carries the saving to BYOK users:
# compose.prod.yaml pins nothing.
#
# `claude-haiku-4-5` WAS TRIED AND FAILS THIS TIER — 11 of 51 golden pairs, returning None for
# required fields ('title' expected 'Coherence', got None) and [] for organize plans. It is not
# marginal; it cannot do the extraction. Do not "save more" by dropping to it.
#
# Sonnet 5 initially looked flaky here too (2 of 5 runs on one input). IT WAS NOT THE MODEL — it
# was two parsing defects on our side, both fixed: `.content` is a LIST of blocks on a
# thinking-enabled model (see `response_text`), and the JSON arrives inside a ```json fence on
# some calls (see `json_from_response`). The model answered correctly every time in both cases.
# That is the lesson worth keeping: on a newer model, "flaky output" is far more likely to be a
# brittle parser than a worse model, and the way to tell is to print the RAW text.
_ESCALATION_DEFAULT = "claude-opus-5"

# ── Which Anthropic models still accept `temperature` ───────────────────────────────────────────
#
# THIS LIST IS THE OPPOSITE WAY ROUND FROM THE OBVIOUS ONE, ON PURPOSE.
#
# Newer Claude models REMOVED the sampling parameters and reject them outright — not a warning, a
# hard 400 `temperature is deprecated for this model`. Measured 2026-09-21, one live call each:
#
#     claude-haiku-4-5    accepted        claude-sonnet-5    400
#     claude-sonnet-4-6   accepted        claude-opus-5      400
#     claude-opus-4-6     accepted        claude-opus-4-8    400
#
# We used to send `temperature=0.0` unconditionally, which meant the escalation tier
# (`claude-opus-4-8`) was ALREADY BROKEN — it would have 400'd on first use. Nobody saw it because
# the tier is flag-gated off and nothing routes there.
#
# The default direction matters more than the list. OMITTING the parameter never fails; SENDING it
# can. So an id we do not recognise is treated as NOT supporting it: a model generation nobody here
# has met yet gets the request that works, rather than the request that 400s. The cost of being
# wrong in this direction is a little more sampling variance on a model that would have accepted
# temperature=0; the cost of being wrong the other way is every call failing.
#
# Ollama is not consulted here — it accepts `temperature` and relies on it.
_ANTHROPIC_TEMPERATURE_SUPPORTED = (
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-3-",
)


def anthropic_accepts_temperature(model_id: str) -> bool:
    """Whether this Anthropic model still accepts a sampling parameter (see the table above).

    Unknown ids answer False — omitting never errors, sending can. Exposed (not private) so the
    invocability tier and the unit tests can assert the rule rather than re-deriving it.
    """
    return model_id.startswith(_ANTHROPIC_TEMPERATURE_SUPPORTED)


@dataclass(frozen=True)
class ModelSpec:
    """A resolved model choice for one graph node — provider-agnostic at the call site."""

    provider: str
    model_id: str
    temperature: float


def _pin(env: Mapping[str, str], provider: str, name: str) -> str | None:
    """Resolve a per-node model pin, PROVIDER-SCOPED name first, then the bare one.

    `ANTHROPIC_SUPERVISOR_MODEL` beats `SUPERVISOR_MODEL` when the provider is Anthropic, and is
    invisible on any other provider.

    WHY THE SCOPED NAME EXISTS. A bare pin follows whichever provider is active. `app-ci.yml`
    declares `provider: choice [anthropic, ollama]` and the app-e2e job takes `MODEL_PROVIDER` from
    it, so that job really does run both ways — and a bare `SUPERVISOR_MODEL=claude-sonnet-5` at job
    scope resolves to `ModelSpec(provider='ollama', model_id='claude-sonnet-5')`, sending a Claude
    id to Ollama. `scripts/agent-stack.mjs` already worked around this by reading
    ANTHROPIC_SUPERVISOR_MODEL and translating it for the container; that convention now lives here
    instead, so it holds for every caller rather than only the one that goes through that script.

    The bare name keeps working unchanged for everyone already using it.
    """
    return (env.get(f"{provider.upper()}_{name}") or env.get(name) or "").strip() or None


def select_model_config(node: str, env: Mapping[str, str]) -> ModelSpec:
    """Resolve the model for a graph node from the environment.

    Default provider is Ollama; MODEL_PROVIDER=anthropic switches to the Claude fallback.
    The escalation tier is always Claude frontier. Per-node env vars override the defaults.
    """
    provider = env.get("MODEL_PROVIDER") or "ollama"

    if node == "supervisor":
        model_id = _pin(env, provider, "SUPERVISOR_MODEL") or _FAST_DEFAULTS[provider]
        return ModelSpec(provider=provider, model_id=model_id, temperature=0.0)

    if node in ("curator", "organizer", "query"):
        model_id = _pin(env, provider, "SPECIALIST_MODEL") or _BALANCED_DEFAULTS[provider]
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
            # These three BARE names only. The provider-scoped names `_pin` also reads
            # (ANTHROPIC_SUPERVISOR_MODEL, OLLAMA_SPECIALIST_MODEL, ...) are deliberately NOT
            # popped and must not be added here: a scoped name is inert on the wrong provider by
            # construction, so an Ollama user cannot inherit an Anthropic pin however the base env
            # was configured. Extending this list would be harmless but would imply the scoped
            # names are dangerous, which is the opposite of why they exist. The bare names ARE
            # dangerous — they follow whatever provider is active — which is exactly why they are
            # popped. (075 FR-016.)
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


def response_text(result: Any) -> str:
    """The assistant's TEXT from a model response — never `str(result.content)`.

    ── WHY THIS EXISTS (and why the naive form is a silent, intermittent bug) ───────────────────

    `.content` is a plain string on Haiku 4.5 and Sonnet 4.6, so `str(msg.content)` worked for
    years. It is NOT a string on a model that thinks: Sonnet 5 and Opus 5 run adaptive thinking by
    DEFAULT, and their `.content` is a list of blocks —

        [{"type": "thinking", "signature": "...", "thinking": ""},
         {"type": "text", "text": "query"}]

    `str()` of that list is a 478-character blob. Downstream it becomes:

      * an intent label that matches nothing in INTENTS, so `classify_intent` returns "ambiguous"
        and the graph asks the user to clarify a request it understood perfectly;
      * a `json.loads` failure in every extractor, caught by their defensive `{}` fallback, so a
        field silently arrives as None and a write proposal is built without it.

    Both look like MODEL QUALITY problems and are not. Worse, they are INTERMITTENT: the same model
    returns a bare string when it does not engage thinking, so a handful of probes can all pass.
    Measured on one input, 5 runs: 4 block-lists, 1 bare string — while the model answered "query"
    correctly every single time.

    `AIMessage.text` concatenates the text blocks and ignores the rest, which is exactly right.
    Falls back to `str(content)` for anything without it (cassette doubles, other providers).
    """
    text = getattr(result, "text", None)
    if isinstance(text, str):
        return text
    if callable(text):  # older langchain-core exposed .text() as a method
        return str(text())
    return str(getattr(result, "content", result))


def json_from_response(result: Any) -> Any:
    """Parse a model's JSON reply, tolerating a markdown code fence.

    Newer models intermittently wrap JSON in ```json ... ``` even when told to return bare JSON —
    measured on Sonnet 5: the SAME prompt returned a fenced block on 1 of 4 calls and a bare object
    on the other 3, with identical, correct content every time. `json.loads` rejects the fenced
    form, the extractors' defensive `except` turns that into `{}`, and a required field silently
    arrives as None. The model was never wrong; the parser was brittle.

    This is intermittent by nature, so a handful of manual probes will not catch it — it shows up as
    a golden pair that fails 2 runs in 5 and gets written off as model flakiness. Strip the fence.
    """
    text = response_text(result).strip()
    if text.startswith("```"):
        # ```json\n{...}\n```  ->  {...}
        body = text.split("\n", 1)[1] if "\n" in text else ""
        text = body.rsplit("```", 1)[0].strip() if "```" in body else body.strip()
    return json.loads(text)


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

        # HTTP 529 (`overloaded_error`) is a documented, retryable provider-capacity signal — not a
        # request defect. langchain-anthropic defaults to max_retries=2, which a brief capacity dip
        # can exhaust: on 2026-07-20 it took out two live-model integration tests mid-run. The SDK
        # applies exponential backoff between attempts, so a higher ceiling costs nothing on the
        # happy path and absorbs a short overload. Tunable for operators who want it lower.
        api_key = resolve_anthropic_key(env)
        max_retries = int(env.get("ANTHROPIC_MAX_RETRIES") or 6)

        # `temperature` is passed ONLY to models that still accept it — a rejected one is a hard
        # 400 on EVERY call, not a warning. See `anthropic_accepts_temperature` for the measured
        # table and for why an unknown id omits it. Written as two explicit constructor calls
        # rather than conditional `**kwargs`: unpacking a dict defeats the type checker here, and
        # this seam is exactly where a silent type error becomes a 400 in production.
        if anthropic_accepts_temperature(spec.model_id):
            return ChatAnthropic(  # type: ignore[call-arg]
                model=spec.model_id,
                temperature=spec.temperature,
                api_key=api_key,  # type: ignore[arg-type]
                max_retries=max_retries,
            )
        return ChatAnthropic(  # type: ignore[call-arg]
            model=spec.model_id,
            api_key=api_key,  # type: ignore[arg-type]
            max_retries=max_retries,
        )

    raise ValueError(f"unknown model provider: {spec.provider!r}")
