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

INTENTS = (
    "add",
    "enrich",
    "organize",
    "navigate",
    "query",
    "search",
    "import",
    "export",
    "out_of_domain",
)

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


def _as_int(value: Any) -> int | None:
    """Coerce a year-like value (int or numeric string) to int; None if not numeric."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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
    # 1. Release year (4-digit, plausible) — before ordinals so "the 2006 one" is a year. Coerce
    #    the option year (it can arrive as a string after a JSON round-trip) so the year step does
    #    not silently fall through to the fragile title-substring step below.
    for token in re.findall(r"\d{4}", low):
        year = int(token)
        if 1900 <= year <= 2100:
            matches = [o for o in options if _as_int(o.get("year")) == year]
            if len(matches) == 1:
                return matches[0]
    # 2. A full option title typed back. Try the MOST SPECIFIC (longest) title first so a short
    #    bare title that is merely a prefix of others ("Avatar") cannot shadow the longer one the
    #    user actually named ("Avatar: The Way of Water"). Length-guarded so a 1–3 char title can't
    #    false-match a common substring (e.g. "a"/"up" inside an off-topic reply).
    for option in sorted(options, key=lambda o: -len(str(o.get("title") or ""))):
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
    "search": "search",
    "import": "import_collection",
    "export": "export_collection",
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
        "- enrich: the user explicitly asks for EXTERNAL INFORMATION about a specific film (facts,"
        ' not locating it) — "tell me about", "what year was", "who directed/starred in", "give me'
        ' details/a synopsis/a preview of". Requires an explicit info-request — a bare "look up X"'
        " is NOT enrich, it is search.\n"
        "- organize: CHANGE something in an existing collection — move, remove, delete, sort, or"
        " rename items; UPDATE a movie's fields (mark/set a movie as owned/ripped/childrens, change"
        " its rating/runtime); or ADD/REMOVE tags. The tell is an imperative to MODIFY existing"
        ' data: "mark X as owned", "set X as ripped", "move X to Y", "remove X", "add the tag T to'
        ' X".\n'
        "- navigate: take the user to one of their COLLECTIONS (a named collection or the current"
        ' screen), or open the add-movie form — "take me to my Favorites collection", "open my'
        ' Sci-Fi collection", or "add a movie" (NO specific film) to open the add form. A MOVIE'
        " target is NOT navigate — it is search.\n"
        "- search: FIND, LOOK UP, OPEN, or CHECK FOR a specific movie/film — locate it in the"
        " user's collections (with a web fallback) or take them to it. Tells: \"show me X\","
        ' "find X", "search for X", "look up X", "look for X", "open X", "go to X", "navigate to'
        ' X", "do I have X", "is X in my collection", or a bare movie title — where X is a FILM'
        " TITLE.\n"
        "- query: ANSWER A COUNT or LIST question about what is ALREADY in the user's own"
        ' collection(s). The tell is an AGGREGATE question scoped to THEIR collection: "how many …'
        ' do I have", "what\'s in my X", "list/show my … movies". A question about whether ONE'
        ' specific film is present ("do I have X", "is X in my collection") is NOT query — it'
        " is search.\n"
        "- import: BULK-load movies INTO the user's collection(s) FROM a spreadsheet/CSV/Excel"
        ' file the user is providing or has uploaded. Tells: "import", "load my movies from this'
        ' file/spreadsheet", "upload this spreadsheet", "import these movies into my collections".'
        " A single named film to add is NOT import — it is add.\n"
        "- export: WRITE OUT the user's existing collection(s) TO a spreadsheet/Excel/CSV file"
        ' for them to download/save. Tells: "export", "download my movies/collections as a'
        ' spreadsheet/Excel/file", "save my collection to a file". This produces a file FROM their'
        " data — the opposite of import.\n"
        "- out_of_domain: NOT about movies, films, or the user's collections at all"
        " (weather, math, code, general chit-chat).\n"
        "Rules: anything about movies, films, or the user's collections is IN DOMAIN — use add,"
        " enrich, organize, navigate, search, query, import, or export, and NEVER out_of_domain."
        " Use out_of_domain ONLY when the topic has nothing to do with movies or collections.\n"
        "import vs add: a FILE/spreadsheet/CSV of many movies to load => import; one named film"
        " => add.\n"
        "import vs export: bringing movies INTO a collection FROM a file => import; writing a"
        " collection OUT TO a file to download/save => export.\n"
        "search vs navigate: a MOVIE title to find/open => search; a COLLECTION to open =>"
        " navigate.\n"
        "search vs enrich: 'find/show/open/look up <movie>' to locate or pull it up => search;"
        " use enrich ONLY when the user explicitly asks for external INFORMATION ('tell me about',"
        " 'what year was', 'who directed', 'give me details/a synopsis of' <movie>).\n"
        "search vs query: anything about ONE specific film — locating it OR checking whether they"
        " have it ('find/show/open <movie>', 'do I have X', 'is X in my collection') => search; an"
        " AGGREGATE question about a collection ('how many', \"what's in\", 'list my movies') =>"
        " query.\n"
        "organize vs the rest: a COMMAND that CHANGES a movie ('mark/set X as owned', 'add the tag"
        " T to X', 'move/remove/rename X') => organize. 'mark/set/move/remove/rename/sort/tag/"
        "update' are ALWAYS organize — NEVER navigate, search, or query — EVEN WHEN the target or"
        " destination collection name contains the words 'movie' or 'collection' (e.g. moving a"
        " film to a collection literally named 'Movie Collection').\n"
        "A SPECIFIC film named for ADDING => add.\n"
        "Reply with only the label, nothing else.\n"
        "Examples:\n"
        "add the movie Coherence (2013) to my Sci-Fi collection => add\n"
        "tell me about the movie Inception => enrich\n"
        "look up details for the movie Blade Runner and show me a preview => enrich\n"
        "move Dune to my Favorites => organize\n"
        "remove The Matrix from my list => organize\n"
        "mark Inception as owned in my Sci-Fi collection => organize\n"
        "set Dune as ripped => organize\n"
        "add the tag classic to The Matrix => organize\n"
        "move this movie to Movie Collection => organize\n"
        "take me to my Favorites collection => navigate\n"
        "open my Sci-Fi collection => navigate\n"
        "let me add a movie to my Favorites => navigate\n"
        "show me Avatar in my collection => search\n"
        "find the movie Dune => search\n"
        "look up the matrix => search\n"
        "navigate to Coherence => search\n"
        "open Inception => search\n"
        "search for The Matrix => search\n"
        "how many movies do I have => query\n"
        "what is in my Sci-Fi collection => query\n"
        "do I have Coherence in my Sci-Fi collection => search\n"
        "is The Matrix in my Wish List => search\n"
        "import my movies from this spreadsheet => import\n"
        "load these movies from a file into my collections => import\n"
        "upload this csv and import the movies => import\n"
        "export my collections to a spreadsheet => export\n"
        "download my movies as an excel file => export\n"
        "save my Sci-Fi collection to a spreadsheet file => export\n"
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
