"""Supervisor node: intent routing ONLY — calls no domain tools.

Implements: T017 (routing), T046 (add/enrich routing), T053 (organize routing),
T058 ("this"/current-target resolution + clarify on ambiguity).

The node classifies intent via the model, then `route_for_intent` (pure) maps the
classified label to the next graph node. `route_after_curator` / `route_after_organizer`
drive the US1 add flow (curator → organizer → approval_gate). The supervisor never calls
MCP domain tools.
"""

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from langgraph.graph import END

if TYPE_CHECKING:
    from src.eval.cassette import ChatModel

INTENTS = ("add", "enrich", "organize", "out_of_domain")

_INTENT_TO_NODE = {
    "add": "curator",
    "enrich": "curator",
    "organize": "organizer",
    "out_of_domain": "decline",
}


def classify_intent(model: "ChatModel", messages: Sequence[Any]) -> str:
    """Classify the latest user request into one intent label using the supervisor model.

    Returns 'ambiguous' for anything outside INTENTS so the graph asks the user to clarify.
    Pure w.r.t. the model: the caller injects the (possibly cassetted) model (T017/T032).
    """
    last = messages[-1].content if messages else ""
    prompt = (
        "You route a user's message in a MOVIE COLLECTION assistant to exactly one label.\n"
        "Labels:\n"
        "- add: add a specific movie/film to one of the user's collections.\n"
        '- enrich: get info, details, or a look-up about a specific movie/film, with no adding'
        ' — "tell me about", "look up", "find", "search for", "what year was".\n'
        "- organize: change an existing collection — move, remove, delete, sort, or rename items.\n"
        "- ambiguous: about the user's movies/films/collections but not clearly add, enrich, or"
        ' organize (e.g. "how many movies do I have", "what is in my watchlist").\n'
        "- out_of_domain: NOT about movies, films, or the user's collections at all"
        " (weather, math, code, general chit-chat).\n"
        "Rules: anything about movies, films, or the user's collections is IN DOMAIN — use add,"
        " enrich, organize, or ambiguous, and NEVER out_of_domain. Use out_of_domain ONLY when"
        " the topic has nothing to do with movies or collections.\n"
        "Reply with only the label, nothing else.\n"
        "Examples:\n"
        "add the movie Coherence (2013) to my Watchlist => add\n"
        "tell me about the movie Inception => enrich\n"
        "find the movie Blade Runner => enrich\n"
        "move Dune to my Favorites => organize\n"
        "remove The Matrix from my list => organize\n"
        "how many movies do I have => ambiguous\n"
        "what is in my Watchlist => ambiguous\n"
        "what's the weather in Paris => out_of_domain\n"
        f"Message: {last}"
    )
    label = str(model.invoke(prompt).content).strip().lower()
    return label if label in INTENTS else "ambiguous"


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
