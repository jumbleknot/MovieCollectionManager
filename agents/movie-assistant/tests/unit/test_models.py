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
    assert spec.model_id == "claude-sonnet-4-6"


def test_escalation_is_always_anthropic_opus_even_on_ollama():
    spec = select_model_config("escalation", {"MODEL_PROVIDER": "ollama"})
    assert spec.provider == "anthropic"
    assert spec.model_id == "claude-opus-4-8"


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
