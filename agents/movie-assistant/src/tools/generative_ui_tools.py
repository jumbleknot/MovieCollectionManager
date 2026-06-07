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
