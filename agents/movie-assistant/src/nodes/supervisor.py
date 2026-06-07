"""Supervisor node: intent routing ONLY — calls no domain tools.

Implements: T017 (routing), T046 (add/enrich routing), T053 (organize routing),
T058 ("this"/current-target resolution + clarify on ambiguity).

The node classifies intent via the model, then `route_for_intent` (pure) maps the
classified label to the next graph node. `route_after_curator` / `route_after_organizer`
drive the US1 add flow (curator → organizer → approval_gate). The supervisor never calls
MCP domain tools.
"""

from typing import Any

from langgraph.graph import END

_INTENT_TO_NODE = {
    "add": "curator",
    "enrich": "curator",
    "organize": "organizer",
    "out_of_domain": "decline",
}


def route_for_intent(intent: str) -> str:
    """Map a classified intent label to the next graph node.

    Unknown/ambiguous intents route to `clarify` (deny-by-guess: ask rather than assume).
    """
    return _INTENT_TO_NODE.get(intent, "clarify")


def route_after_curator(state: dict[str, Any]) -> str:
    """After enrichment: an add with a confident candidate goes to the organizer; else end.

    Enrich-only intents, and ambiguous/no-match adds, end after the curator (the user got a
    preview or a clarify prompt) — only a resolved add proceeds to build a write proposal.
    """
    if state.get("intent") == "add" and state.get("candidate") is not None:
        return "organizer"
    return END


def route_after_organizer(state: dict[str, Any]) -> str:
    """A built proposal goes to the HITL approval gate; otherwise the turn ends."""
    if state.get("pending_proposal") is not None:
        return "approval_gate"
    return END
