"""Integration test for build_chat_model (T016 completion).

Builds a real LangChain chat model from a ModelSpec and invokes it against the running
Ollama (the default provider) — no mocking. Requires Ollama serving the supervisor-tier
model (qwen2.5) at OLLAMA_BASE_URL (default http://localhost:11434).
"""

import os

import httpx
import pytest

from src.models import build_chat_model, select_model_config

_OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")


def _require_ollama() -> None:
    """Skip when Ollama isn't serving — this test invokes a REAL Ollama model (no mocking), so it
    is meaningless without one. CI runs the runtime model as Anthropic and has no Ollama, so it
    skips there (allowlisted in conftest so the CI skip-escalation does not treat it as a broken
    harness). Locally it runs against host Ollama."""
    try:
        httpx.get(f"{_OLLAMA_BASE_URL}/api/tags", timeout=3.0).raise_for_status()
    except Exception as exc:  # noqa: BLE001 — any connect/transport failure ⇒ skip
        pytest.skip(f"Ollama not reachable at {_OLLAMA_BASE_URL}: {exc}")


def test_build_ollama_supervisor_model_invokes():
    _require_ollama()
    spec = select_model_config("supervisor", {})  # ollama / qwen2.5
    model = build_chat_model(spec)
    response = model.invoke("Reply with exactly: OK")
    assert response.content.strip(), "model returned empty content"


def test_unknown_provider_raises():
    from src.models import ModelSpec

    with pytest.raises(ValueError):
        build_chat_model(ModelSpec(provider="bogus", model_id="x", temperature=0.0))
