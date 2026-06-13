"""Unit tests for render_movie_card props (013 US3 / T028).

A movie card built for an in-collection movie carries movieId + collectionId so the client can
deep-link to its detail screen; a look-up-only (TMDB preview) card omits them (null), so the
client renders it non-interactive.
"""

from __future__ import annotations

from src.proposals import EnrichedMovieCandidate
from src.tools.generative_ui_tools import render_movie_card


def _candidate() -> EnrichedMovieCandidate:
    return EnrichedMovieCandidate(
        sourceId="tmdb:603",
        title="The Matrix",
        year=1999,
        overview="A hacker learns the truth.",
        genres=["Action", "Sci-Fi"],
        posterUrl="https://image.tmdb.org/p.jpg",
    )


def test_in_collection_card_carries_movie_and_collection_ids() -> None:
    props = render_movie_card(
        _candidate(),
        movie_id="607f191e810c19729de860ea",
        collection_id="507f1f77bcf86cd799439011",
    )
    assert props["movieId"] == "607f191e810c19729de860ea"
    assert props["collectionId"] == "507f1f77bcf86cd799439011"
    assert props["title"] == "The Matrix"


def test_lookup_only_card_omits_ids() -> None:
    props = render_movie_card(_candidate())
    assert props["movieId"] is None
    assert props["collectionId"] is None
