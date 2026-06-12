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

import os
from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from src.kill_switch import assistant_disabled
from src.nodes.supervisor import (
    resolve_option,
    route_after_approval,
    route_after_curator,
    route_after_organizer,
    route_for_intent,
)
from src.proposals import EnrichedMovieCandidate, Proposal


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
    # Multi-turn add lifecycle (T069/R14): "" | "awaiting_pick" | "awaiting_collection".
    add_stage: str
    # The disambiguation option the supervisor resolved this turn, handed to the curator so
    # it fetches details for the chosen sourceId instead of re-searching (ephemeral; cleared
    # once consumed). Carries no credential — SC-004 (`state.forbid_token_fields`).
    resolved_pick: dict[str, Any] | None
    # Remaining organize batches awaiting sequential approval (US2/FR-009b); each is a Proposal.
    pending_batches: list[Proposal]
    # Sanitized readable UI-state snapshot for context-aware "this" resolution (US3/R15):
    # {current_screen, collection_id, movie_id, active_filter_keys, nav_depth}. Non-secret,
    # structural only; the runtime organizer overwrites it from config["configurable"] each run
    # (carried via the BFF→gateway header bridge, never the run body).
    ui_snapshot: dict[str, Any] | None
    # Multi-turn SEARCH workflow (013 US7): "" | "awaiting_scope" | "awaiting_collection" |
    # "awaiting_pick". `search_scope` is a collection id or "web"; `search_query` is the title
    # carried across button-tap turns; `search_results` are the candidates awaiting a pick.
    # Pure-conversation state — nothing here carries a credential (SC-004).
    search_stage: str
    search_scope: str
    search_query: str
    search_results: list[dict[str, Any]]


# Fields cleared when an add concludes (approve/reject/decline) so a finished add never leaks
# into the next turn (T069/R14, RC4). `intent` is recomputed by the supervisor each turn.
_ADD_STATE_RESET: dict[str, Any] = {
    "add_stage": "",
    "options": [],
    "resolved_pick": None,
    "candidate": None,
    "match_confidence": "",
    "pending_batches": [],
}

# Fields cleared when a SEARCH workflow concludes or is escaped (013 US7) so a finished search
# never leaks into the next turn (mirrors _ADD_STATE_RESET).
_SEARCH_STATE_RESET: dict[str, Any] = {
    "search_stage": "",
    "search_scope": "",
    "search_query": "",
    "search_results": [],
}


def _default_classifier(messages: Sequence[Any]) -> str:
    """Classify the latest user request into an intent label using the supervisor model.

    Runtime-only (keeps import/compile LLM-free). Delegates the prompt/parse to
    `classify_intent` so the same decision is exercised by the golden gate (T032).
    """
    import os

    from src.models import build_chat_model, select_model_config
    from src.nodes.supervisor import classify_intent

    model = build_chat_model(select_model_config("supervisor", os.environ))
    return classify_intent(model, messages)


def _supervisor_node(
    classifier: Callable[[Sequence[Any]], str],
    kill_switch: Callable[[], bool],
    circuit: Any | None = None,
) -> Any:
    def supervisor(state: GraphState) -> dict[str, Any]:
        # Kill switch (T061/FR-019/SC-009): short-circuit BEFORE any classify / tool work, so a
        # disabled assistant performs zero side effects. Clears any in-progress add.
        if kill_switch():
            return {"intent": "disabled", **_ADD_STATE_RESET}
        # Error-rate circuit breaker (T030, Control Tower): when too many recent runs have failed
        # the breaker is open → short-circuit to the same graceful-degradation reply, giving the
        # provider/stack a cooldown. No new user surface; zero side effects.
        if circuit is not None and circuit.opened():
            return {"intent": "degraded", **_ADD_STATE_RESET}
        messages = state.get("messages") or []
        last = messages[-1] if messages else None
        # Only classify a genuine user turn. A non-human last message means this run was
        # triggered by a client continuation (e.g. a render_movie_card tool round-trip), not a
        # new request — end quietly ("noop") instead of re-classifying it, which would mislabel
        # it out_of_domain and emit a spurious decline after a successful preview.
        if last is None or getattr(last, "type", None) != "human":
            return {"intent": "noop"}
        # Graceful degradation (T061/FR-018): a provider/reasoning failure becomes a
        # "couldn't complete" reply, never a crash or a misroute. Clears any in-progress add.
        # The outcome feeds the circuit breaker (T030) — a failure here is the error signal.
        from src.observability import record_turn, record_turn_failure

        try:
            intent = classifier(messages)
        except Exception:  # noqa: BLE001 — any provider/model failure degrades gracefully
            if circuit is not None:
                circuit.record(False)
            record_turn_failure()  # OTel metric (no-op until configured) — T030b
            return {"intent": "degraded", **_ADD_STATE_RESET}
        if circuit is not None:
            circuit.record(True)
        record_turn(intent)  # OTel run counter, labelled by classified intent — T030b
        stage = state.get("add_stage") or ""
        text = str(getattr(last, "content", "") or "")

        # Continue an in-progress add (multi-turn disambiguation, T069/R14).
        if stage == "awaiting_pick":
            pick = resolve_option(text, state.get("options") or [])
            if pick is not None:
                # An ordinal/year/title pick — hand the chosen option to the curator.
                return {"intent": "add", "resolved_pick": pick}
            # No resolvable pick: respect a clear switch (organize) or off-topic abandonment
            # (out_of_domain → decline escapes the pending pick); otherwise it is an in-domain
            # reply (a re-typed title or garbled pick) → curator re-enriches / re-offers.
            if intent in ("organize", "out_of_domain"):
                return {"intent": intent}
            return {"intent": "add"}

        if stage == "awaiting_collection" and intent != "organize":
            # The reply names the collection for the already-resolved movie (a bare collection
            # name classifies as out_of_domain, so that signal can't gate here) → curator threads
            # it to the organizer; only a clear `organize` switch escapes.
            return {"intent": "add"}

        # Continue an in-progress SEARCH workflow (US7). A button tap or refinement re-enters the
        # search node, which advances its own stage / handles "exit search". A clear new action
        # (add/organize) escapes the workflow and clears its state. add_stage and search_stage are
        # mutually exclusive (a turn is either mid-add or mid-search).
        if state.get("search_stage"):
            # A reply that PICKS one of the offered results is not a new add/organize command — it
            # is a disambiguation pick (a button tap posts a bare "Title (Year)" that can classify
            # as `add`). Keep it in the search node, which resolves the pick in pure code. Only a
            # reply that does NOT match an offered result escapes to a genuinely new action (Bug 2:
            # a pick leaked to the curator's enrich preview, which carries no clickable TMDB link).
            if intent in ("add", "organize") and resolve_option(
                text, state.get("search_results") or []
            ) is None:
                return {"intent": intent, **_SEARCH_STATE_RESET}
            return {"intent": "search"}

        return {"intent": intent}

    return supervisor


def _responder(text: str) -> Any:
    def node(state: GraphState) -> dict[str, list[AIMessage]]:
        return {"messages": [AIMessage(content=text)]}

    return node


def _noop_gate(state: GraphState) -> dict[str, Any]:
    """Default approval gate when none is injected — unreachable without a pending proposal."""
    return {}


def _decline_node(state: GraphState) -> dict[str, Any]:
    """Out-of-domain decline. Also clears any in-progress add (the user switched topics) so it
    cannot leak into a later turn (T069/R14, RC4)."""
    return {
        "messages": [AIMessage(content="I can only help with your movie collections.")],
        **_ADD_STATE_RESET,
    }


def _degrade_node(state: GraphState) -> dict[str, Any]:
    """Graceful degradation (T061/FR-018): a provider/reasoning failure → a clear "couldn't
    complete" reply, never a silent or partial unauthorized action. Clears any in-progress add."""
    return {
        "messages": [
            AIMessage(content="Sorry — I couldn't complete that just now. Please try again.")
        ],
        **_ADD_STATE_RESET,
    }


def _disabled_node(state: GraphState) -> dict[str, Any]:
    """Kill switch engaged (T061/FR-019/SC-009): the assistant is disabled — reply that it is
    unavailable and do nothing else (zero side effects; existing app flows are unaffected)."""
    return {
        "messages": [AIMessage(content="The movie assistant is temporarily unavailable.")],
        **_ADD_STATE_RESET,
    }


def build_graph(
    classifier: Callable[[Sequence[Any]], str] | None = None,
    *,
    curator: Any | None = None,
    organizer: Any | None = None,
    navigator: Any | None = None,
    query: Any | None = None,
    search: Any | None = None,
    approval_gate: Any | None = None,
    checkpointer: Any | None = None,
    kill_switch: Callable[[], bool] | None = None,
    circuit: Any | None = None,
) -> Any:
    """Compile the supervisor graph. Unset nodes default to tool-free responders (pre-US1).

    `kill_switch` is checked at the supervisor entry per run (T061); the default reads the
    `AGENT_KILL_SWITCH` env flag (Unleash-backed in production — T030). When it returns True the
    supervisor short-circuits to the `disabled` node with zero side effects.

    `circuit` (an `ErrorRateBreaker`, optional) is the error-rate breaker (T030): when open the
    supervisor short-circuits to `degrade`; each turn's provider outcome is recorded into it.
    """
    classifier = classifier or _default_classifier
    kill_switch = kill_switch or (lambda: assistant_disabled(os.environ))
    curator = curator or _responder("curator: discovery & enrichment not yet implemented (US1).")
    organizer = organizer or _responder(
        "organizer: collection organization not yet implemented (US2)."
    )
    navigator = navigator or _responder(
        "navigator: in-app navigation not yet implemented (US3)."
    )
    query = query or _responder(
        "query: collection questions not yet implemented (US4)."
    )
    search = search or _responder(
        "search: movie search workflow not yet implemented (US7)."
    )
    approval_gate = approval_gate or _noop_gate
    checkpointer = checkpointer or MemorySaver()

    builder = StateGraph(GraphState)
    builder.add_node("supervisor", _supervisor_node(classifier, kill_switch, circuit))
    builder.add_node("curator", curator)
    builder.add_node("organizer", organizer)
    builder.add_node("navigator", navigator)
    builder.add_node("query", query)
    builder.add_node("search", search)
    builder.add_node("approval_gate", approval_gate)
    builder.add_node("decline", _decline_node)
    builder.add_node("degrade", _degrade_node)
    builder.add_node("disabled", _disabled_node)
    builder.add_node(
        "clarify",
        _responder(
            "I can add a movie to one of your collections or look up details about a movie. "
            "What would you like to do?"
        ),
    )

    builder.add_edge(START, "supervisor")
    builder.add_conditional_edges(
        "supervisor",
        lambda state: route_for_intent(state["intent"]),
        {
            "curator": "curator",
            "organizer": "organizer",
            "navigator": "navigator",
            "query": "query",
            "search": "search",
            "decline": "decline",
            "degrade": "degrade",
            "disabled": "disabled",
            "clarify": "clarify",
            END: END,
        },
    )
    builder.add_conditional_edges(
        "curator", route_after_curator, {"organizer": "organizer", END: END}
    )
    builder.add_conditional_edges(
        "organizer", route_after_organizer, {"approval_gate": "approval_gate", END: END}
    )
    builder.add_conditional_edges(
        "approval_gate", route_after_approval, {"approval_gate": "approval_gate", END: END}
    )
    builder.add_edge("navigator", END)
    builder.add_edge("query", END)
    builder.add_edge("search", END)
    builder.add_edge("decline", END)
    builder.add_edge("degrade", END)
    builder.add_edge("disabled", END)
    builder.add_edge("clarify", END)

    return builder.compile(checkpointer=checkpointer)


# Compiled entrypoint referenced by gateway.create_app() and langgraph.json.
# Uses the real classifier + tool-free node defaults (the add flow activates when the agent
# layer is deployed with MCP-backed nodes). Compiling does NOT invoke the classifier.
graph = build_graph()
