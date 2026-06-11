"""T022 — web-api-mcp TMDB tools against the REAL TMDB API.

Verify RED:  pnpm nx test:integration web-api-mcp -- -k tmdb  → fails (tools absent)
Verify GREEN (after impl + a TMDB_API_KEY): same → passes against real TMDB.

Uses stable facts about TMDB id 603 (The Matrix, 1999). matchConfidence is a typed
outcome — `none` for no match, `exact` for a single match, `ambiguous` for several — so
the curator never fabricates metadata (spec edge case).
"""

from __future__ import annotations

import pytest

from src.tools import get_movie_details, make_tmdb_client, search_title


@pytest.mark.asyncio
async def test_tmdb_search_title_finds_known_movie(tmdb_api_key: str, tmdb_base_url: str) -> None:
    async with make_tmdb_client(tmdb_api_key, tmdb_base_url) as client:
        result = await search_title(client, "The Matrix", year=1999)

    assert result["matchConfidence"] in {"exact", "ambiguous"}
    assert result["results"], "expected at least one TMDB result"
    ids = {r["sourceId"] for r in result["results"]}
    assert "tmdb:603" in ids
    matrix = next(r for r in result["results"] if r["sourceId"] == "tmdb:603")
    assert matrix["title"] == "The Matrix"
    assert matrix["year"] == 1999


@pytest.mark.asyncio
async def test_tmdb_search_title_no_match_is_typed_none(
    tmdb_api_key: str, tmdb_base_url: str
) -> None:
    async with make_tmdb_client(tmdb_api_key, tmdb_base_url) as client:
        result = await search_title(client, "zzzqqxxnotarealmovietitle12345")

    assert result["matchConfidence"] == "none"
    assert result["results"] == []


@pytest.mark.asyncio
async def test_tmdb_get_movie_details_shapes_enriched_candidate(
    tmdb_api_key: str, tmdb_base_url: str
) -> None:
    async with make_tmdb_client(tmdb_api_key, tmdb_base_url) as client:
        candidate = await get_movie_details(client, "tmdb:603")

    assert candidate["source"] == "tmdb"
    assert candidate["sourceId"] == "tmdb:603"
    assert candidate["title"] == "The Matrix"
    assert candidate["year"] == 1999
    assert "Action" in candidate["genres"]
    assert candidate["language"] == "English"  # original_language en -> english_name
    assert candidate["overview"]  # non-empty synopsis
    assert candidate["posterUrl"].startswith("https://")
