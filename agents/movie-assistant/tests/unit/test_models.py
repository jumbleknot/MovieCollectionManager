"""Unit tests for the provider-abstracted model selection (T016).

Covers research.md R1: default provider is self-hosted Ollama in every environment;
Anthropic Claude is the documented fallback; the escalation tier is always Claude
frontier regardless of base provider; safety-relevant nodes use low temperature; and
per-node model env vars override the defaults.

These test the PURE selection logic (env -> ModelSpec) only — no LLM is instantiated,
so no langchain/langgraph dependency is needed to run them.
"""

import pytest

from src.models import ModelSpec, select_model_config


def test_default_provider_is_ollama_for_supervisor():
    spec = select_model_config("supervisor", {})
    assert spec == ModelSpec(provider="ollama", model_id="qwen2.5", temperature=0.0)


def test_default_specialist_models_are_ollama_32b():
    for node in ("curator", "organizer"):
        spec = select_model_config(node, {})
        assert spec.provider == "ollama"
        assert spec.model_id == "qwen2.5:32b"


def test_anthropic_fallback_supervisor():
    spec = select_model_config("supervisor", {"MODEL_PROVIDER": "anthropic"})
    assert spec.provider == "anthropic"
    assert spec.model_id == "claude-haiku-4-5"


def test_anthropic_fallback_specialist():
    spec = select_model_config("curator", {"MODEL_PROVIDER": "anthropic"})
    assert spec.provider == "anthropic"
    # Feature 075: 4.6 -> 5 for a -33% on extraction. haiku-4-5 was tried and FAILS this tier
    # (11 of 51 golden pairs); see _BALANCED_DEFAULTS for that and for the two parsing defects that
    # made sonnet-5 look flaky when it was not.
    assert spec.model_id == "claude-sonnet-5"


def test_provider_scoped_pin_wins_over_the_bare_name():
    """FR-007b: `<PROVIDER>_SUPERVISOR_MODEL` resolves ahead of `SUPERVISOR_MODEL`."""
    env = {
        "MODEL_PROVIDER": "anthropic",
        "ANTHROPIC_SUPERVISOR_MODEL": "claude-sonnet-5",
        "SUPERVISOR_MODEL": "should-not-win",
    }
    assert select_model_config("supervisor", env).model_id == "claude-sonnet-5"

    env_spec = {
        "MODEL_PROVIDER": "anthropic",
        "ANTHROPIC_SPECIALIST_MODEL": "claude-haiku-4-5",
        "SPECIALIST_MODEL": "should-not-win",
    }
    assert select_model_config("curator", env_spec).model_id == "claude-haiku-4-5"


def test_provider_scoped_pin_is_INERT_on_a_different_provider():
    """FR-007a — the regression this whole mechanism exists to prevent.

    `app-ci.yml` declares `provider: choice [anthropic, ollama]` and the app-e2e job reads
    MODEL_PROVIDER from it, so that job genuinely runs BOTH ways. A bare pin follows whichever
    provider is active, which sends a Claude id to Ollama and breaks the run. A provider-scoped
    pin cannot: Ollama reads OLLAMA_SUPERVISOR_MODEL and never sees the Anthropic one.
    """
    env = {"MODEL_PROVIDER": "ollama", "ANTHROPIC_SUPERVISOR_MODEL": "claude-sonnet-5"}
    spec = select_model_config("supervisor", env)
    assert spec.provider == "ollama"
    assert spec.model_id == "qwen2.5", (
        "an Anthropic-scoped pin leaked onto the Ollama provider — this is exactly the "
        "`provider: ollama` dispatch breakage the scoped names exist to prevent"
    )


def test_the_bare_name_still_works_when_no_scoped_pin_is_present():
    """The bare override is unchanged for everyone already using it (e.g. agent-stack.mjs)."""
    env = {"MODEL_PROVIDER": "ollama", "SUPERVISOR_MODEL": "qwen2.5:14b"}
    assert select_model_config("supervisor", env).model_id == "qwen2.5:14b"


def test_temperature_is_offered_only_to_models_that_accept_it():
    """FR-026: the measured support table, asserted offline so the live tier need not re-derive it.

    Newer Claude models reject `temperature` with a hard 400 on every call. Measured 2026-09-21.
    """
    from src.models import anthropic_accepts_temperature

    for supported in ("claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"):
        assert anthropic_accepts_temperature(supported), f"{supported} accepts temperature"
    for rejected in ("claude-sonnet-5", "claude-opus-5", "claude-opus-4-8"):
        assert not anthropic_accepts_temperature(rejected), (
            f"{rejected} REJECTS temperature with a 400 — sending it breaks every call"
        )


def test_an_unrecognised_model_omits_temperature_rather_than_risking_a_400():
    """FR-026a: the default direction, which is the whole point of the predicate.

    Omitting the parameter never fails; sending it can. So a model generation nobody here has met
    yet must get the request that WORKS, not the one that 400s. If this ever flips to
    default-allow, the next Claude release breaks every call and the failure looks like an outage.
    """
    from src.models import anthropic_accepts_temperature

    for unknown in ("claude-haiku-6", "claude-sonnet-7-2", "some-future-model", ""):
        assert not anthropic_accepts_temperature(unknown), (
            f"unknown id {unknown!r} must OMIT temperature — default-allow reintroduces the 400"
        )


def test_escalation_is_always_anthropic_opus_even_on_ollama():
    # The PROPERTY under test is the provider pin — escalation never degrades to a local model.
    # The id moved 4-8 -> 5 in feature 075: `claude-opus-4-8` REJECTS the `temperature` this code
    # used to send unconditionally, so the tier was already dead on first use (dormant, so never
    # observed). Opus 5 is the same list price, current, and works. See models.py's
    # `anthropic_accepts_temperature`.
    spec = select_model_config("escalation", {"MODEL_PROVIDER": "ollama"})
    assert spec.provider == "anthropic"
    assert spec.model_id == "claude-opus-5"


def test_safety_relevant_nodes_use_low_temperature():
    for node in ("supervisor", "organizer"):
        assert select_model_config(node, {}).temperature == 0.0


def test_per_node_env_override_wins():
    spec = select_model_config("supervisor", {"SUPERVISOR_MODEL": "llama3.1"})
    assert spec.model_id == "llama3.1"
    assert spec.provider == "ollama"


def test_unknown_node_raises():
    with pytest.raises(ValueError):
        select_model_config("nonsense-node", {})
