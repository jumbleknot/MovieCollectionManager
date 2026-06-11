"""T021 — movie-mcp READ tools against the REAL mc-service.

Verify RED:  pnpm nx test:integration movie-mcp -- -k read_tools  → fails (tools absent)
Verify GREEN (after impl): same → passes against real mc-service.

The tools are thin wrappers over mc-service REST that forward the user's JWT; mc-service
applies RBAC + DAC unchanged. We assert the wrapper surfaces mc-service's response shapes
faithfully (no domain remapping — FR-022) for a freshly-seeded, isolated collection.
"""

from __future__ import annotations

import httpx
import pytest

from src.tools import (
    count_movies,
    get_collection,
    list_collections,
    list_movies,
    make_mc_client,
)


@pytest.mark.asyncio
async def test_read_tools_list_collections_includes_seeded(
    mc_base_url: str, mc_token: str, seeded_collection: dict[str, str]
) -> None:
    async with make_mc_client(mc_base_url, mc_token) as client:
        collections = await list_collections(client)

    assert isinstance(collections, list)
    ids = {c["collectionId"] for c in collections}
    assert seeded_collection["collectionId"] in ids
    seeded = next(c for c in collections if c["collectionId"] == seeded_collection["collectionId"])
    assert seeded["name"] == seeded_collection["name"]
    assert seeded["movieCount"] == 1  # exactly the one movie we seeded


@pytest.mark.asyncio
async def test_read_tools_get_collection_returns_seeded(
    mc_base_url: str, mc_token: str, seeded_collection: dict[str, str]
) -> None:
    async with make_mc_client(mc_base_url, mc_token) as client:
        collection = await get_collection(client, seeded_collection["collectionId"])

    assert collection["collectionId"] == seeded_collection["collectionId"]
    assert collection["name"] == seeded_collection["name"]
    assert collection["ownerId"]  # mc-service stamps the owner (Keycloak UUID)


@pytest.mark.asyncio
async def test_read_tools_list_movies_returns_seeded_movie(
    mc_base_url: str, mc_token: str, seeded_collection: dict[str, str]
) -> None:
    async with make_mc_client(mc_base_url, mc_token) as client:
        page = await list_movies(client, seeded_collection["collectionId"])

    # mc-service shape forwarded unchanged: { items: [...], nextCursor: str|null }
    assert "items" in page and "nextCursor" in page
    titles = {m["title"] for m in page["items"]}
    assert seeded_collection["movieTitle"] in titles


@pytest.mark.asyncio
async def test_read_tools_count_movies_returns_total_and_filters(
    mc_base_url: str, mc_token: str, seeded_collection: dict[str, str]
) -> None:
    async with make_mc_client(mc_base_url, mc_token) as client:
        total = await count_movies(client, seeded_collection["collectionId"])
        filtered = await count_movies(
            client, seeded_collection["collectionId"], filters={"genre": "NoSuchGenreXYZ"}
        )

    # mc-service shape forwarded unchanged: { count: N }
    assert total == {"count": 1}  # exactly the one seeded movie
    assert filtered == {"count": 0}  # a filter with no matches counts zero (server-side)


@pytest.mark.asyncio
async def test_read_tools_get_collection_unauthorized_mirrors_mc_service_404(
    mc_base_url: str, mc_token: str
) -> None:
    # IDOR-protected: a collection the user cannot reach is denied identically to a
    # missing one (feature 011 Clean DAC) — the wrapper must surface mc-service's 404,
    # not swallow it (FR-010/011/012a).
    async with make_mc_client(mc_base_url, mc_token) as client:
        with pytest.raises(httpx.HTTPStatusError) as excinfo:
            await get_collection(client, "0123456789abcdef01234567")  # well-formed, nonexistent
    assert excinfo.value.response.status_code == 404
