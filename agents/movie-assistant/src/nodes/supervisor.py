"""Supervisor node: intent routing ONLY — calls no domain tools.

Implements: T017 (routing), T046 (add/enrich routing), T053 (organize routing),
T058 ("this"/current-target resolution + clarify on ambiguity).

The node classifies intent via the model, then `route_for_intent` (pure) maps the
classified label to the next graph node. `route_after_curator` / `route_after_organizer`
drive the US1 add flow (curator → organizer → approval_gate). The supervisor never calls
MCP domain tools.
"""

import re
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from langgraph.graph import END

if TYPE_CHECKING:
    from src.eval.cassette import ChatModel

INTENTS = ("add", "enrich", "organize", "navigate", "query", "out_of_domain")

# Ordinal words → zero-based index into the offered options (T069/R14, RC1). Bare cardinals
# ("one", "two") are deliberately excluded: "one" is too common ("the X one") to mean an index.
_ORDINALS: dict[str, int] = {
    "first": 0, "1st": 0,
    "second": 1, "2nd": 1,
    "third": 2, "3rd": 2,
    "fourth": 3, "4th": 3,
    "fifth": 4, "5th": 4,
    "last": -1,
}


def resolve_option(text: str, options: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    """Resolve a disambiguation pick against the offered options — deterministically (no LLM).

    Honours, in order: a release year ("the 2003 one"), an exact title the user typed back,
    an ordinal word ("the first one", "the last one"), then a 1-based index ("number 2", "#3").
    Returns the chosen option, or None when the reply does not unambiguously name one (→ re-ask,
    never guess — FR-014). Bare-title re-types that are not a full option title are left to the
    curator to re-enrich.
    """
    if not options:
        return None
    low = text.lower()
    # 1. Release year (4-digit, plausible) — before ordinals so "the 2006 one" is a year.
    for token in re.findall(r"\d{4}", low):
        year = int(token)
        if 1900 <= year <= 2100:
            matches = [o for o in options if o.get("year") == year]
            if len(matches) == 1:
                return matches[0]
    # 2. A full option title typed back (length-guarded so a 1–3 char title can't false-match
    #    a common substring, e.g. "a"/"up" inside an off-topic reply).
    for option in options:
        title = str(option.get("title") or "").lower()
        if len(title) >= 4 and title in low:
            return option
    # 3. Ordinal word.
    for word, idx in _ORDINALS.items():
        if re.search(rf"\b{re.escape(word)}\b", low):
            try:
                return options[idx]
            except IndexError:
                return None
    # 4. 1-based index ("number 2", "option 3", "#1", or a bare single digit).
    match = re.search(r"\b(?:number|option|no\.?|#)?\s*([1-9])\b", low)
    if match:
        idx = int(match.group(1)) - 1
        if 0 <= idx < len(options):
            return options[idx]
    return None

_INTENT_TO_NODE = {
    "add": "curator",
    "enrich": "curator",
    "organize": "organizer",
    "navigate": "navigator",
    "query": "query",
    "out_of_domain": "decline",
    # T061 graceful degradation / kill switch: provider/reasoning failure → "degrade"
    # ("couldn't complete"); kill switch engaged → "disabled" ("temporarily unavailable").
    "degraded": "degrade",
    "disabled": "disabled",
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
        '- enrich: look up info about a specific film from the OUTSIDE world (not scoped to the'
        ' user\'s own collection) — "tell me about", "look up", "search for", "what year was",'
        ' "find the movie X".\n'
        "- organize: change an existing collection — move, remove, delete, sort, or rename items.\n"
        "- navigate: take the user to a screen they already have, or open the add-movie form —"
        ' "take me to", "open", "show me", "go to", "jump to" one of their collections or a movie'
        ' in it; or "add a movie" (NO specific film named) to open the add form.\n'
        "- query: ANSWER A QUESTION about what is ALREADY in the user's own collection(s) — count,"
        ' list, or check-for-a-title-in-their-collection. The tell is a question scoped to THEIR'
        ' collection: "how many … do I have", "what\'s in my X", "list/show my … movies", "do I'
        ' have X", "is X in my collection", "find X IN my collection", "which of my … are …".\n'
        "- out_of_domain: NOT about movies, films, or the user's collections at all"
        " (weather, math, code, general chit-chat).\n"
        "Rules: anything about movies, films, or the user's collections is IN DOMAIN — use add,"
        " enrich, organize, navigate, or query, and NEVER out_of_domain. Use out_of_domain ONLY"
        " when the topic has nothing to do with movies or collections. enrich vs query is the"
        " linguistic tell: a BARE look-up of a film ('look up Blade Runner') is enrich; the SAME"
        " film scoped to the user's own collection ('do I have Blade Runner', 'is Blade Runner in"
        " my collection') is query. A SPECIFIC film named for adding => add; opening a screen or"
        " the add form with no specific film => navigate.\n"
        "Reply with only the label, nothing else.\n"
        "Examples:\n"
        "add the movie Coherence (2013) to my Sci-Fi collection => add\n"
        "tell me about the movie Inception => enrich\n"
        "find the movie Blade Runner => enrich\n"
        "move Dune to my Favorites => organize\n"
        "remove The Matrix from my list => organize\n"
        "take me to my Favorites collection => navigate\n"
        "open my Sci-Fi collection => navigate\n"
        "let me add a movie to my Favorites => navigate\n"
        "how many movies do I have => query\n"
        "what is in my Sci-Fi collection => query\n"
        "do I have Coherence in my Sci-Fi collection => query\n"
        "list my horror movies => query\n"
        "what's the weather in Paris => out_of_domain\n"
        f"Message: {last}"
    )
    label = str(model.invoke(prompt).content).strip().lower()
    return label if label in INTENTS else "ambiguous"


def route_for_intent(intent: str) -> str:
    """Map a classified intent label to the next graph node.

    `noop` (a non-user continuation run — see the supervisor node) routes straight to END.
    Unknown/ambiguous intents route to `clarify` (deny-by-guess: ask rather than assume).
    """
    if intent == "noop":
        return END
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


def route_after_approval(state: dict[str, Any]) -> str:
    """Loop back to the gate while a next batch is queued (sequential approvals, FR-009b)."""
    if state.get("pending_proposal") is not None:
        return "approval_gate"
    return END
