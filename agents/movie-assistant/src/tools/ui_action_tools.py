"""UI-action tools: return a client instruction (navigate/prefill); no MCP server involved.

Implements: T059 (navigate_*, prefill_*). These are PURE instruction builders (no I/O, no
token) — a node emits the result as an AG-UI tool call that the CopilotKit client maps to a
client-side effect (expo-router navigation / open+prefill the add-movie form). They are
ALLOWLISTED (the client dispatches only these names; the BFF `ui-action-authorizer` T026
role-gates the structural target). `prefill_add_movie` touches UNSAVED form state, so it is
HITL-surfaced (the user still confirms before the draft is applied — it never submits).

No tool here writes domain data; writes go only through `movie-mcp` on the approved-resume
path. Contract: specs/012-multi-agent-mvp/contracts/generative-ui-and-actions.md.
"""

from __future__ import annotations

from typing import Any

NAVIGATE_TO_COLLECTION = "navigate_to_collection"
NAVIGATE_TO_MOVIE = "navigate_to_movie"
PREFILL_ADD_MOVIE = "prefill_add_movie"
DOWNLOAD_EXPORT = "download_export"

# The only UI-action tool names a node may emit / the client may dispatch (default-deny).
UI_ACTION_TOOLS = frozenset(
    {NAVIGATE_TO_COLLECTION, NAVIGATE_TO_MOVIE, PREFILL_ADD_MOVIE, DOWNLOAD_EXPORT}
)

# Actions that affect unsaved user state → surfaced for explicit confirmation (HITL).
_HITL_ACTIONS = frozenset({PREFILL_ADD_MOVIE})


def navigate_to_collection(collection_id: str) -> dict[str, Any]:
    """Build `navigate_to_collection` args — client navigates to that collection screen."""
    return {"collectionId": collection_id}


def navigate_to_movie(collection_id: str, movie_id: str) -> dict[str, Any]:
    """Build `navigate_to_movie` args — client navigates to the movie-detail screen."""
    return {"collectionId": collection_id, "movieId": movie_id}


def prefill_add_movie(collection_id: str, movie: dict[str, Any] | None) -> dict[str, Any]:
    """Build `prefill_add_movie` args — client opens + pre-fills the add-movie form (no submit).

    `movie` is an optional draft payload (title/year/etc.); an empty draft just opens the form.
    """
    return {"collectionId": collection_id, "movie": dict(movie) if movie else {}}


def download_export(handle: str, filename: str) -> dict[str, Any]:
    """Build `download_export` args — client downloads the built `.xlsx` via the BFF route.

    `handle` is the transient download handle from `build_workbook` (the BFF download route
    streams it, ownership-scoped + single-use); it carries no credential. Read-only (no HITL).
    """
    return {"handle": handle, "filename": filename}


def is_ui_action(name: str) -> bool:
    """Whether `name` is an allowlisted UI-action tool (default-deny for anything else)."""
    return name in UI_ACTION_TOOLS


def requires_hitl(name: str) -> bool:
    """Whether dispatching `name` must be human-confirmed (touches unsaved state)."""
    return name in _HITL_ACTIONS
