"""Navigator node: turn a "navigate" intent into an allowlisted UI-action tool call (T059, US3).

The supervisor routes a navigation request ("take me to my Favorites", "open Coherence",
"let me add a movie here") here. The navigator resolves the target in PURE CODE — no LLM, so
no golden re-record (per the T069 disambiguation discipline) — against the user's OWN
collections/movies via downscoped reads, then emits one of the three allowlisted UI-action
tool calls (`navigate_to_collection` / `navigate_to_movie` / `prefill_add_movie`). It can
never drive the UI to a resource the user couldn't reach directly (FR-011/FR-012): the targets
are taken from the user's own `list_collections` / `list_movies` results, and the BFF
`ui-action-authorizer` (T026) is the compensating role gate at the security boundary. An
unresolvable or ambiguous target asks the user to clarify rather than guessing (FR-014).

`build_navigator(list_collections, list_movies)` is the seam: both are async reads (closures
over `invoke_tool` → movie-mcp in production; stubs in tests). `prefill_add_movie` touches
unsaved form state and so is HITL-surfaced client-side (it opens + pre-fills the form, never
submits — the user still confirms).
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Any

from langchain_core.messages import AIMessage

from src.nodes.organizer import (
    _as_int,
    _last_user_text,
    _resolve_current_collection,
    references_current_screen,
)
from src.nodes.supervisor import resolve_option
from src.tools.generative_ui_tools import RENDER_SELECTION, render_selection
from src.tools.ui_action_tools import (
    NAVIGATE_TO_COLLECTION,
    NAVIGATE_TO_MOVIE,
    PREFILL_ADD_MOVIE,
    navigate_to_collection,
    navigate_to_movie,
    prefill_add_movie,
)

ListCollectionsFn = Callable[[], Awaitable[list[dict[str, Any]]]]
# (collection_id, search_term) -> the matching movies. Server-side narrowing, first page only —
# the same bounded shape `search.py`'s `_owned_matches` uses (FR-002).
ListMoviesFn = Callable[[str, str], Awaitable[list[dict[str, Any]]]]

# "add a/another/new movie/film" or an explicit "open the add form" → open + prefill the form
# (no specific title to look up). A NAMED film ("add Inception") is the add intent (curator),
# not navigation — that never reaches this node.
_WANTS_PREFILL_RE = re.compile(
    r"\badd\s+(?:a|an|another|new|the)?\s*(?:new\s+)?(?:movie|film)\b"
    r"|\bprefill\b|\bopen\s+the\s+add\b|\bstart\s+adding\b",
    re.IGNORECASE,
)
# A reset that clears any in-progress add lifecycle (navigation is unrelated to a pending add) and
# any in-progress navigate disambiguation (040 US1) — a terminal navigate action concludes it.
_LIFECYCLE_RESET: dict[str, Any] = {
    "pending_proposal": None,
    "add_stage": "",
    "resolved_pick": None,
    "navigate_stage": "",
    "navigate_options": [],
}


def _resolve_collection(
    text: str, ui_snapshot: Any, collections: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Resolve the target collection (current-screen ref or a named match), else None.

    Returns the matched collection dict, or None when nothing / more than one matches (→ ask).
    """
    if references_current_screen(text):
        current = _resolve_current_collection(ui_snapshot, collections)
        if current is not None:
            return next(
                (c for c in collections if str(c.get("collectionId")) == current.collection_id),
                None,
            )
    low = text.casefold()
    matches = [
        c
        for c in collections
        if (name := str(c.get("name", "")).casefold()) and len(name) >= 2 and name in low
    ]
    return matches[0] if len(matches) == 1 else None


# Navigation phrasing that can never be part of a movie title. Used only to decide whether a
# movie read is worth making — never to resolve anything.
_NAV_FILLER_RE = re.compile(
    r"\b(?:take|show|bring|let|me|us|my|mine|the|a|an|to|into|in|on|at|of|please|go|goto|open|"
    r"view|see|navigate|jump|switch|back|over|collection|collections|list|screen|page)\b",
    re.IGNORECASE,
)


def _movie_term(text: str, collection_name: str = "") -> str:
    """The part of `text` that could name a movie — the search term for the bounded read.

    Strips the collection name (already resolved from `list_collections`) and the navigation
    phrasing, leaving the words that might be a title. Used BOTH to decide whether a read is
    worth making and as the term mc-service narrows on.
    """
    residual = text.casefold()
    if collection_name:
        residual = residual.replace(collection_name.casefold(), " ")
    stripped = re.sub(r"[^\w\s]", " ", _NAV_FILLER_RE.sub(" ", residual))
    term = " ".join(stripped.split())
    # The fallback triggers when the strip leaves too little to MATCH — not merely when it leaves
    # nothing. `_match_movie` needs 4+ characters, so a title like "THE 0" (5 chars, but only "0"
    # survives the filter) would otherwise be gated out of the read that would have resolved it.
    # Hypothesis found exactly that, after an earlier run had found the empty case.
    if len(term) >= 4 or collection_name:
        return term
    # Nothing survived the filler strip — but a TITLE can be made entirely of those words
    # ("The Collection", "Open Water", "The Page Turner" are all real films). With NO collection
    # resolved, returning "" would skip the read and answer "which collection?" to a member who
    # just named a film, so fall back to the raw text and let `_match_movie` verify.
    #
    # The fallback is deliberately NOT applied when a collection DID resolve: there, "navigate to
    # Sci-Fi" also leaves only filler, and reading that collection's movies is the whole defect
    # FR-002 exists to remove. The cost is that a filler-worded title inside a named collection
    # resolves to the COLLECTION rather than the movie — a correct answer one tap short of the
    # best one, which is the right side to err on.
    raw = re.sub(r"[^\w\s]", " ", residual)
    return " ".join(raw.split())


def _mentions_a_movie(text: str, collection_name: str) -> bool:
    """Whether `text` could still name a movie once the collection name is taken out (FR-002).

    `_match_movie` only ever matches a title of **4+ characters appearing verbatim** in the text.
    So if nothing that long survives, no title can possibly match and the read is provably
    useless — which is the whole point: "navigate to <collection>" must not get slower as that
    collection grows.

    Conservative by construction: anything substantive left over means we still read, so this can
    only skip a read that could not have resolved anything.
    """
    # Measured EXACTLY as `_match_movie` measures a title — total length, spaces included. A
    # non-space count would gate out a read that the matcher would then have resolved ("I Am" is
    # a 4-character title with 3 letters); Hypothesis found that mismatch, so keep the two
    # measures identical rather than merely similar.
    return len(_movie_term(text, collection_name)) >= 4


def _match_movie(text: str, movies: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Resolve a single movie named in `text` against the collection's movies, else None.

    Length-guarded (≥4 chars) so a short title can't false-match a common substring; ambiguous
    (>1) → None (navigate to the collection instead and let the user pick on-screen).
    """
    low = text.casefold()
    matches = [
        m
        for m in movies
        if (title := str(m.get("title", "")).casefold()) and len(title) >= 4 and title in low
    ]
    return matches[0] if len(matches) == 1 else None


async def _resolve_movie_across(
    text: str,
    collections: list[dict[str, Any]],
    list_movies: ListMoviesFn,
) -> tuple[str, dict[str, Any] | str | None, dict[str, Any] | None]:
    """Resolve a movie named in freeform `text` across ALL the user's collections (013 US6).

    Pure code (no LLM → no golden re-record), following the Phase-9 resolver discipline:
    length-guarded substring match, longest-title-wins (a short title shadowed by a longer one),
    then a `(title, year)` tie-break when same-titled films collide. Returns one of:
      ("one", collection, movie) — a unique resolution → navigate to its detail screen,
      ("many", title, None)      — same title in >1 place → ask which (never guess),
      ("none", None, None)       — no movie named → caller falls back to the collection ask.
    """
    low = text.casefold()
    term = _movie_term(text)
    if len(term) < 4:  # same measure as `_match_movie`'s title guard
        return ("none", None, None)  # nothing that could be a 4+ char title — don't read at all
    hits: list[tuple[dict[str, Any], dict[str, Any], str]] = []
    for coll in collections:
        cid = str(coll.get("collectionId") or "")
        if not cid:
            continue
        # ONE bounded call per collection. mc-service narrows; the verification below stays pure
        # code, so a loose server-side match can never navigate somewhere the text didn't name.
        for movie in await list_movies(cid, term):
            title = str(movie.get("title", "")).casefold()
            if len(title) >= 4 and title in low:
                hits.append((coll, movie, title))
    if not hits:
        return ("none", None, None)
    # Longest matching title wins — "Coherence" must not shadow "Coherence: Resurgence".
    longest = max(len(t) for (_, _, t) in hits)
    hits = [h for h in hits if len(h[2]) == longest]
    if len(hits) == 1:
        return ("one", hits[0][0], hits[0][1])
    # Same (longest) title in multiple places → discriminate by a year in the text (uniqueness
    # is (title, year)); a unique year match resolves, otherwise it stays ambiguous.
    year_match = re.search(r"\b(?:19|20)\d{2}\b", text or "")
    if year_match:
        year = int(year_match.group(0))
        year_hits = [(c, m) for (c, m, _) in hits if _as_int(m.get("year")) == year]
        if len(year_hits) == 1:
            return ("one", year_hits[0][0], year_hits[0][1])
    return ("many", str(hits[0][1].get("title") or ""), None)


def _action_message(content: str, name: str, args: dict[str, Any], call_id: str) -> dict[str, Any]:
    return {
        **_LIFECYCLE_RESET,
        "messages": [
            AIMessage(content=content, tool_calls=[{"name": name, "args": args, "id": call_id}])
        ],
    }


def _named_target(text: str) -> str:
    """What the member appears to have named, with their own casing — "" if nothing.

    Used ONLY to explain a failure (FR-004), never to resolve anything: saying *what* did not
    resolve is the difference between a typo and a missing collection, and the member cannot tell
    those apart from a bare "which collection did you mean?".
    """
    residual = re.sub(r"[^\w\s]", " ", _NAV_FILLER_RE.sub(" ", text or ""))
    return " ".join(residual.split())


def _clarify(collections: list[dict[str, Any]], named: str = "") -> dict[str, Any]:
    """Ask which collection to open — as clickable buttons (013 Enhancement 1 / 040 US1).

    Each collection renders as a `render_selection` button (kind `collection`, cap 5 + view more)
    whose `value` is the BARE collection name (not "open <name>"). A tap posts that bare name; the
    supervisor's `navigate_stage` guard keeps the turn in the navigator (a bare name would
    otherwise re-classify as a movie `search`), and this node OPENS the picked collection. The
    offered collections are stashed in `navigate_options` (carrying `collectionId` + a `title`
    alias so `resolve_option` can match the tap deterministically). The text listing remains the
    fallback for clients that don't render the tool.
    """
    nav_options = [
        {
            "label": str(c.get("name") or ""),
            "value": str(c.get("name") or ""),
            "title": str(c.get("name") or ""),
            "collectionId": str(c.get("collectionId") or ""),
            "kind": "collection",
        }
        for c in collections
        if c.get("name")
    ]
    names = ", ".join(str(c.get("name", "")) for c in collections if c.get("name"))
    listing = f" You have: {names}." if names else ""
    # FR-004: name what did not resolve. FR-005 keeps the generic degrade reply for genuine
    # provider failures, so this path must explain itself rather than borrow that sentence.
    question = (
        f'I couldn\'t find a collection called "{named}". Which one did you mean?'
        if named
        else "Which collection would you like to open?"
    )
    if not nav_options:
        return {
            **_LIFECYCLE_RESET,
            "messages": [AIMessage(content=question)],
        }
    return {
        **_LIFECYCLE_RESET,
        "navigate_stage": "awaiting_collection",
        "navigate_options": nav_options,
        "messages": [
            AIMessage(
                content=f"{question}{listing}",
                tool_calls=[
                    {
                        "name": RENDER_SELECTION,
                        "args": render_selection(nav_options),
                        "id": "nav-clarify",
                    }
                ],
            )
        ],
    }


def build_navigator(
    *,
    list_collections: ListCollectionsFn,
    list_movies: ListMoviesFn | None = None,
) -> Any:
    """Build the navigator graph node from injected downscoped reads."""

    async def navigator(state: dict[str, Any]) -> dict[str, Any]:
        text = _last_user_text(state.get("messages", []))

        # Resume an in-progress navigate disambiguation (040 US1 / Item 4a): the user tapped one of
        # the offered collection buttons (a bare collection name). The supervisor's navigate_stage
        # guard already confirmed the reply resolves an offered option; open that collection
        # directly (and clear the stage) rather than re-resolving from scratch.
        if state.get("navigate_stage"):
            picked = resolve_option(text, state.get("navigate_options") or [])
            if picked is not None:
                cid = str(picked.get("collectionId") or "")
                name = picked.get("label") or picked.get("title") or ""
                return _action_message(
                    f'Opening "{name}".',
                    NAVIGATE_TO_COLLECTION,
                    navigate_to_collection(cid),
                    f"nav-{cid}",
                )

        collections = await list_collections()
        target = _resolve_collection(text, state.get("ui_snapshot"), collections)

        # Prefill (open the add-movie form) — only when a target collection resolves.
        if _WANTS_PREFILL_RE.search(text or ""):
            if target is None:
                return _clarify(collections, _named_target(text))
            cid = str(target["collectionId"])
            return _action_message(
                f'Opening the add-movie form for "{target.get("name")}". '
                "Fill it in and save when you're ready.",
                PREFILL_ADD_MOVIE,
                prefill_add_movie(cid, {}),
                f"pre-{cid}",
            )

        if target is None:
            # US6: no collection named — try to resolve a movie named in the text ACROSS all the
            # user's collections, and go straight to its detail screen. Ambiguous/none never guess.
            if list_movies is not None:
                status, coll, movie = await _resolve_movie_across(text, collections, list_movies)
                if status == "one" and isinstance(coll, dict) and movie is not None:
                    cid = str(coll["collectionId"])
                    mid = str(movie["movieId"])
                    return _action_message(
                        f'Opening "{movie.get("title")}".',
                        NAVIGATE_TO_MOVIE,
                        navigate_to_movie(cid, mid),
                        f"nav-{cid}-{mid}",
                    )
                if status == "many":
                    title = coll  # ("many", title, None)
                    return {
                        **_LIFECYCLE_RESET,
                        "messages": [
                            AIMessage(
                                content=f'You have more than one "{title}". '
                                "Which collection is it in?"
                            )
                        ],
                    }
            return _clarify(collections, _named_target(text))

        cid = str(target["collectionId"])
        # A movie named within the resolved collection → go straight to its detail screen.
        # FR-002: only read the movies when the request could actually name one. A name-only
        # navigation ("navigate to Sci-Fi") resolves from `list_collections` alone and must not
        # touch the collection's contents — that read is what made the request scale with the
        # collection's size and, past ~30 pages, exhaust the navigator's tool-call budget.
        if list_movies is not None and _mentions_a_movie(text, str(target.get("name") or "")):
            term = _movie_term(text, str(target.get("name") or ""))
            movie = _match_movie(text, await list_movies(cid, term))
            if movie is not None:
                mid = str(movie["movieId"])
                return _action_message(
                    f'Opening "{movie.get("title")}".',
                    NAVIGATE_TO_MOVIE,
                    navigate_to_movie(cid, mid),
                    f"nav-{cid}-{mid}",
                )

        return _action_message(
            f'Opening "{target.get("name")}".',
            NAVIGATE_TO_COLLECTION,
            navigate_to_collection(cid),
            f"nav-{cid}",
        )

    return navigator
