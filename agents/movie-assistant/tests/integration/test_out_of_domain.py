"""T060: out-of-domain topic confinement (FR-005) — verified LIVE against the runtime model.

FR-005: the assistant MUST be confined to the movie-collection domain and MUST decline requests
outside it. The deployed topic guard is the supervisor's `classify_intent` → `out_of_domain` →
the graph's `decline` node ("I can only help with your movie collections."). T019's NeMo rails
(`guardrails/rails.co`) encode the same in/out-of-domain intents; the live, LLM-backed topic
decision is exercised here against the real model.

These assert, against the REAL runtime model (Ollama `qwen2.5` in dev, or whatever
`MODEL_PROVIDER` configures), that:
- a clearly non-movie request classifies `out_of_domain` and the full graph declines with zero
  side effects (no candidate / no proposal);
- an in-domain request is NOT declined (guards against over-declining — see
  [[project_supervisor_intent_prompt]]: the classifier once mislabelled in-domain look-ups).

Skips cleanly if no model is reachable (constitution §Test Type Integrity: real deps, never
mocked). Run: `pnpm nx test:integration movie-assistant -- -k out_of_domain` (needs Ollama up,
or `MODEL_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`).
"""

from __future__ import annotations

import os

import pytest
from langchain_core.messages import HumanMessage

from src.graph import build_graph
from src.models import build_chat_model, select_model_config
from src.nodes.supervisor import classify_intent

# Clearly NOT about movies/films/collections.
_OUT_OF_DOMAIN = [
    "what's the weather in Paris today",
    "write me a haiku about the ocean",
    "what is 17 times 23",
    "help me debug this Python function",
]

# In-domain — must route to add/enrich/organize/ambiguous, NEVER out_of_domain.
_IN_DOMAIN = [
    "add Inception to my Sci-Fi collection",
    "tell me about the movie The Matrix",
    "how many movies do I have",
    "remove Dune from my Favorites collection",
]


def _supervisor_model() -> object:
    try:
        model = build_chat_model(select_model_config("supervisor", os.environ))
        model.invoke("reply with the single word ok")  # smoke: confirm the model is reachable
        return model
    except Exception as exc:  # noqa: BLE001 — any build/connect failure ⇒ skip, never fail
        pytest.skip(f"supervisor model not reachable: {exc}")


@pytest.fixture(scope="module")
def supervisor_model() -> object:
    return _supervisor_model()


@pytest.mark.parametrize("prompt", _OUT_OF_DOMAIN)
def test_out_of_domain_request_is_classified_out_of_domain(
    supervisor_model: object, prompt: str
) -> None:
    assert classify_intent(supervisor_model, [HumanMessage(content=prompt)]) == "out_of_domain"


@pytest.mark.parametrize("prompt", _IN_DOMAIN)
def test_in_domain_request_is_not_declined(supervisor_model: object, prompt: str) -> None:
    intent = classify_intent(supervisor_model, [HumanMessage(content=prompt)])
    assert intent != "out_of_domain", f"in-domain request over-declined: {prompt!r}"


async def test_full_graph_declines_out_of_domain_with_zero_side_effects(
    supervisor_model: object,
) -> None:
    # The full graph: supervisor (live classify) → route_for_intent → decline node → decline copy.
    def classifier(messages: object) -> str:
        return classify_intent(supervisor_model, messages)  # type: ignore[arg-type]

    graph = build_graph(classifier=classifier)
    result = await graph.ainvoke(
        {"messages": [("user", "what's the weather in Paris today")]},
        {"configurable": {"thread_id": "t060-ood"}},
    )

    last = str(result["messages"][-1].content).lower()
    assert "movie collections" in last  # the decline copy (FR-005)
    assert result.get("pending_proposal") is None  # zero side effects — no write proposed
    assert result.get("candidate") is None
