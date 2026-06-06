"""Integration test for build_chat_model (T016 completion).

Builds a real LangChain chat model from a ModelSpec and invokes it against the running
Ollama (the default provider) — no mocking. Requires Ollama serving the supervisor-tier
model (qwen2.5) at OLLAMA_BASE_URL (default http://localhost:11434).
"""

import pytest

from src.models import build_chat_model, select_model_config


def test_build_ollama_supervisor_model_invokes():
    spec = select_model_config("supervisor", {})  # ollama / qwen2.5
    model = build_chat_model(spec)
    response = model.invoke("Reply with exactly: OK")
    assert response.content.strip(), "model returned empty content"


def test_unknown_provider_raises():
    from src.models import ModelSpec

    with pytest.raises(ValueError):
        build_chat_model(ModelSpec(provider="bogus", model_id="x", temperature=0.0))
