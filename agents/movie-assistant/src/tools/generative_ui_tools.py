"""Generative-UI tools: return structured props only (client renders existing components).

Implements: T040 (render_movie_card), T052 (render_collection_summary, render_wishlist).
Contract: specs/012-multi-agent-mvp/contracts/generative-ui-and-actions.md.

These are PURE prop builders (no I/O, no token). A specialist node emits the result as an
AG-UI tool call (`render_*`) that the CopilotKit client maps to an existing Components-Layer
component via `useRenderTool` (universal web+mobile; no server-rendered UI). `proposal_item_id`
links a preview card to a pending ProposalItem so the approval UI can correlate them.
"""

from __future__ import annotations

from typing import Any

from src.proposals import EnrichedMovieCandidate

RENDER_MOVIE_CARD = "render_movie_card"
RENDER_COLLECTION_SUMMARY = "render_collection_summary"


def render_movie_card(
    candidate: EnrichedMovieCandidate,
    *,
    movie_id: str | None = None,
    proposal_item_id: str | None = None,
) -> dict[str, Any]:
    """Build `render_movie_card` props from an EnrichedMovieCandidate (contract shape)."""
    return {
        "movieId": movie_id,
        "title": candidate.title,
        "year": candidate.year,
        "posterUrl": candidate.poster_url,
        "genres": list(candidate.genres),
        "overview": candidate.overview,
        "source": candidate.source,
        "proposalItemId": proposal_item_id,
    }


def render_collection_summary(collection: dict[str, Any]) -> dict[str, Any]:
    """Build `render_collection_summary` props from an mc-service collection dict (contract shape).

    A "wishlist" renders here too — it is just a user-named collection (no distinct entity).
    Pure: derives only display fields; carries no token. `role` defaults to "owner" when the
    list endpoint omits it.
    """
    return {
        "collectionId": str(collection.get("collectionId") or ""),
        "name": str(collection.get("name") or ""),
        "movieCount": int(collection.get("movieCount") or 0),
        "role": str(collection.get("role") or "owner"),
    }
