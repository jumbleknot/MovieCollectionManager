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
ListMoviesFn = Callable[[str], Awaitable[list[dict[str, Any]]]]

# "add a/another/new movie/film" or an explicit "open the add form" → open + prefill the form
# (no specific title to look up). A NAMED film ("add Inception") is the add intent (curator),
# not navigation — that never reaches this node.
_WANTS_PREFILL_RE = re.compile(
    r"\badd\s+(?:a|an|another|new|the)?\s*(?:new\s+)?(?:movie|film)\b"
    r"|\bprefill\b|\bopen\s+the\s+add\b|\bstart\s+adding\b",
    re.IGNORECASE,
)
# A reset that clears any in-progress add lifecycle (navigation is unrelated to a pending add).
_LIFECYCLE_RESET = {"pending_proposal": None, "add_stage": "", "resolved_pick": None}


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
    hits: list[tuple[dict[str, Any], dict[str, Any], str]] = []
    for coll in collections:
        cid = str(coll.get("collectionId") or "")
        if not cid:
            continue
        for movie in await list_movies(cid):
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


def _clarify(collections: list[dict[str, Any]]) -> dict[str, Any]:
    """Ask which collection to open — as clickable buttons (013 Enhancement 1).

    Each collection renders as a `render_selection` button (kind `collection`, cap 5 + view more);
    a tap posts "open <name>", which re-routes through `navigate` → this node → `navigate_to_
    collection`. The text listing remains the fallback for clients that don't render the tool.
    """
    options = [
        {"label": str(c.get("name") or ""), "value": f"open {c.get('name')}", "kind": "collection"}
        for c in collections
        if c.get("name")
    ]
    names = ", ".join(str(c.get("name", "")) for c in collections if c.get("name"))
    listing = f" You have: {names}." if names else ""
    if not options:
        return {
            **_LIFECYCLE_RESET,
            "messages": [AIMessage(content="Which collection would you like to open?")],
        }
    return {
        **_LIFECYCLE_RESET,
        "messages": [
            AIMessage(
                content=f"Which collection would you like to open?{listing}",
                tool_calls=[
                    {
                        "name": RENDER_SELECTION,
                        "args": render_selection(options),
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
        collections = await list_collections()
        target = _resolve_collection(text, state.get("ui_snapshot"), collections)

        # Prefill (open the add-movie form) — only when a target collection resolves.
        if _WANTS_PREFILL_RE.search(text or ""):
            if target is None:
                return _clarify(collections)
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
            return _clarify(collections)

        cid = str(target["collectionId"])
        # A movie named within the resolved collection → go straight to its detail screen.
        if list_movies is not None:
            movie = _match_movie(text, await list_movies(cid))
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
