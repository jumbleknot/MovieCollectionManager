"""Orchestration-Layer: the stateful supervisor graph.

Implements: T020 (compile + AG-UI), T046 (US1 add-flow wiring). Wires
supervisor → conditional → curator → organizer → approval_gate (HITL) and compiles with a
checkpointer. Served over AG-UI by src/gateway.py.

The graph STRUCTURE always includes the full add flow, but the curator/organizer/
approval_gate nodes are INJECTABLE: the defaults are tool-free responders (no candidate /
no proposal → the conditional routers fall through to END), so `build_graph()` with no args
keeps the pre-US1 behavior and the existing E2E regression stays green (SC-005). Real nodes
(built with MCP-backed tool closures) are injected by tests now, and by the gateway once the
agent layer is deployed — then the add flow (enrich → propose → interrupt → resume → apply)
activates. The subject token reaches the real nodes via `config["configurable"]` (task-safe),
never via checkpointed state (SC-004).

`build_graph(...)` keeps importing LLM-free: the default classifier is invoked only at runtime.
"""

from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from src.nodes.supervisor import route_after_curator, route_after_organizer, route_for_intent
from src.proposals import EnrichedMovieCandidate, Proposal

_INTENTS = ("add", "enrich", "organize", "out_of_domain")


class GraphState(MessagesState):
    """Conversation messages + the working state for the active turn (US1).

    No token field — the subject token is an ephemeral run value passed via
    `config["configurable"]`, never checkpointed here (`state.forbid_token_fields`).
    """

    intent: str
    candidate: EnrichedMovieCandidate | None
    match_confidence: str
    target_collection_name: str
    pending_proposal: Proposal | None
    status: str
    options: list[dict[str, Any]]
    apply_result: Any


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


def _noop_gate(state: GraphState) -> dict[str, Any]:
    """Default approval gate when none is injected — unreachable without a pending proposal."""
    return {}


def build_graph(
    classifier: Callable[[Sequence[Any]], str] | None = None,
    *,
    curator: Any | None = None,
    organizer: Any | None = None,
    approval_gate: Any | None = None,
    checkpointer: Any | None = None,
) -> Any:
    """Compile the supervisor graph. Unset nodes default to tool-free responders (pre-US1)."""
    classifier = classifier or _default_classifier
    curator = curator or _responder("curator: discovery & enrichment not yet implemented (US1).")
    organizer = organizer or _responder(
        "organizer: collection organization not yet implemented (US2)."
    )
    approval_gate = approval_gate or _noop_gate
    checkpointer = checkpointer or MemorySaver()

    builder = StateGraph(GraphState)
    builder.add_node("supervisor", _supervisor_node(classifier))
    builder.add_node("curator", curator)
    builder.add_node("organizer", organizer)
    builder.add_node("approval_gate", approval_gate)
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
    builder.add_conditional_edges(
        "curator", route_after_curator, {"organizer": "organizer", END: END}
    )
    builder.add_conditional_edges(
        "organizer", route_after_organizer, {"approval_gate": "approval_gate", END: END}
    )
    builder.add_edge("approval_gate", END)
    builder.add_edge("decline", END)
    builder.add_edge("clarify", END)

    return builder.compile(checkpointer=checkpointer)


# Compiled entrypoint referenced by gateway.create_app() and langgraph.json.
# Uses the real classifier + tool-free node defaults (the add flow activates when the agent
# layer is deployed with MCP-backed nodes). Compiling does NOT invoke the classifier.
graph = build_graph()
