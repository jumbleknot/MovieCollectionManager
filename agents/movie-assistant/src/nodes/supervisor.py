"""Supervisor node: intent routing ONLY — calls no domain tools.

Implements: T017 (routing), T046 (add/enrich routing), T053 (organize routing),
T058 ("this"/current-target resolution + clarify on ambiguity).

The node classifies intent via the model, then `route_for_intent` (pure) maps the
classified label to the next graph node. The supervisor never calls MCP domain tools.
"""

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
