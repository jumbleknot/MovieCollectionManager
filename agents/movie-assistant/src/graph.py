"""Orchestration-Layer: the stateful supervisor graph.

Implements: T020. Wires supervisor -> conditional(route_for_intent) -> specialists/HITL
and compiles with a checkpointer. The runtime is served over AG-UI by src/gateway.py.

`build_graph(classifier)` is the seam: the default classifier is the real model-backed
intent classifier (invoked only at RUNTIME, never at import/compile), so importing this
module compiles the graph without contacting any LLM. Tests inject a stub classifier for
deterministic wiring checks.

The curator/organizer nodes here are minimal responders — their real behavior (enrichment,
HITL-gated writes) lands in US1 (T039-T046) and US2 (T050-T053). The checkpointer is the
in-memory saver for now; the Postgres (agent-db) checkpointer is wired with T024/deploy.
"""

from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from src.nodes.supervisor import route_for_intent

_INTENTS = ("add", "enrich", "organize", "out_of_domain")


class GraphState(MessagesState):
    """Conversation messages + the supervisor's classified intent for this turn."""

    intent: str


def _default_classifier(messages: Sequence[Any]) -> str:
    """Classify the latest user request into an intent label using the supervisor model.

    Runtime-only (keeps import/compile LLM-free). Falls back to 'ambiguous' for anything
    outside the known label set so the graph asks the user to clarify (FR-014).
    """
    import os

    from src.models import build_chat_model, select_model_config

    model = build_chat_model(select_model_config("supervisor", os.environ))
    last = messages[-1].content if messages else ""
    prompt = (
        "You classify a user's request about THEIR MOVIE COLLECTIONS into exactly one label.\n"
        f"Labels: {', '.join(_INTENTS)}, ambiguous.\n"
        "Reply with only the label, nothing else.\n"
        f"Request: {last}"
    )
    label = str(model.invoke(prompt).content).strip().lower()
    return label if label in _INTENTS else "ambiguous"


def _supervisor_node(classifier: Callable[[Sequence[Any]], str]) -> Any:
    def supervisor(state: GraphState) -> dict[str, str]:
        return {"intent": classifier(state["messages"])}

    return supervisor


def _responder(text: str) -> Any:
    def node(state: GraphState) -> dict[str, list[AIMessage]]:
        return {"messages": [AIMessage(content=text)]}

    return node


def build_graph(classifier: Callable[[Sequence[Any]], str] | None = None) -> Any:
    """Compile the supervisor graph. `classifier` defaults to the real model-backed one."""
    classifier = classifier or _default_classifier

    builder = StateGraph(GraphState)
    builder.add_node("supervisor", _supervisor_node(classifier))
    builder.add_node(
        "curator", _responder("curator: discovery & enrichment not yet implemented (US1).")
    )
    builder.add_node(
        "organizer", _responder("organizer: collection organization not yet implemented (US2).")
    )
    builder.add_node("decline", _responder("I can only help with your movie collections."))
    builder.add_node(
        "clarify",
        _responder("Could you clarify what you'd like to do with your movie collection?"),
    )

    builder.add_edge(START, "supervisor")
    builder.add_conditional_edges(
        "supervisor",
        lambda state: route_for_intent(state["intent"]),
        {
            "curator": "curator",
            "organizer": "organizer",
            "decline": "decline",
            "clarify": "clarify",
        },
    )
    for terminal in ("curator", "organizer", "decline", "clarify"):
        builder.add_edge(terminal, END)

    return builder.compile(checkpointer=MemorySaver())


# Compiled entrypoint referenced by gateway.create_app() and langgraph.json.
# Uses the real classifier, but compiling does NOT invoke it (no LLM call at import).
graph = build_graph()
