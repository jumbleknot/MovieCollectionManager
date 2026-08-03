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
    add_movie,
    count_movies,
    get_collection,
    get_movie_metadata,
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


# ── 047 US4 (T064/T066, RQ-4): the published movie-option values ────────────────────────────
#
# The assistant must offer exactly the media formats mc-service accepts, and the constitution
# forbids the agent holding a copy of them. movie-mcp's job here is to be a THIN wrapper: it
# returns mc-service's body unchanged, adding no transformation and no domain logic (FR-022).
#
# Asserted against a REAL mc-service, never a mock — mocking the dependency under integration
# would prove only that the wrapper calls a function, not that the two agree on the contract.


@pytest.mark.asyncio
async def test_read_tools_movie_metadata_returns_the_accepted_formats(
    mc_base_url: str, mc_token: str
) -> None:
    async with make_mc_client(mc_base_url, mc_token) as client:
        metadata = await get_movie_metadata(client)

    # mc-service shape forwarded unchanged: { mediaFormats: [...] }
    assert set(metadata.keys()) == {"mediaFormats"}
    assert metadata["mediaFormats"] == ["DVD", "Blu-Ray", "Blu-Ray 3D", "UHD Blu-Ray"]


@pytest.mark.asyncio
async def test_read_tools_movie_metadata_body_is_returned_unchanged(
    mc_base_url: str, mc_token: str
) -> None:
    """The wrapper adds nothing: its result equals the raw endpoint body byte for byte.

    This is the assertion that keeps movie-mcp thin. A transformation added later — sorting,
    renaming, filtering — fails here rather than silently changing what the member is offered.
    """
    async with make_mc_client(mc_base_url, mc_token) as client:
        via_tool = await get_movie_metadata(client)
        raw = await client.get("/api/v1/movie-metadata")
        raw.raise_for_status()

    assert via_tool == raw.json()


@pytest.mark.asyncio
async def test_read_tools_movie_metadata_values_are_accepted_by_add_movie(
    mc_base_url: str, mc_token: str, seeded_collection: dict[str, str]
) -> None:
    """Every published value must be one mc-service will STORE.

    The whole point of publishing the list is that a value the member picks is a value the
    write endpoint takes. If these ever diverge, every ownership add fails validation — so the
    round trip is asserted end to end rather than assumed from the enum.
    """
    async with make_mc_client(mc_base_url, mc_token) as client:
        formats = (await get_movie_metadata(client))["mediaFormats"]

        # A fully-populated MovieRequest — mc-service rejects missing non-Option fields.
        # Every published format is sent in BOTH list fields, so a value that the domain
        # publishes but the write path rejects fails right here.
        movie = {
            "title": "047 metadata round-trip",
            "year": 2001,
            "contentType": "Movie",
            "language": "English",
            "owned": True,
            "ripped": True,
            "childrens": False,
            "ownedMedia": formats,
            "ripQuality": formats,
            "genres": ["Drama"],
            "rated": "PG-13",
            "directors": [],
            "actors": [],
            "tags": [],
            "movieSet": None,
            "originalTitle": None,
            "releaseDate": None,
            "outline": None,
            "plot": None,
            "runtime": None,
            "externalIds": [],
        }

        created = await add_movie(
            client,
            seeded_collection["collectionId"],
            movie,
            idempotency_key="047-metadata-roundtrip",
        )

        assert created["ownedMedia"] == formats
        assert created["ripQuality"] == formats
