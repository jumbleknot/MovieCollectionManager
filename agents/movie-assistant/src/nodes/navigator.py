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
    _last_user_text,
    _resolve_current_collection,
    references_current_screen,
)
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


def _action_message(content: str, name: str, args: dict[str, Any], call_id: str) -> dict[str, Any]:
    return {
        **_LIFECYCLE_RESET,
        "messages": [
            AIMessage(content=content, tool_calls=[{"name": name, "args": args, "id": call_id}])
        ],
    }


def _clarify(collections: list[dict[str, Any]]) -> dict[str, Any]:
    names = ", ".join(str(c.get("name", "")) for c in collections if c.get("name"))
    listing = f" You have: {names}." if names else ""
    return {
        **_LIFECYCLE_RESET,
        "messages": [
            AIMessage(content=f"Which collection would you like to open?{listing}")
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
