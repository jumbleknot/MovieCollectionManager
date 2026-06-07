"""T043 — movie-mcp WRITE tools against the REAL mc-service.

Verify RED:  pnpm nx test:integration movie-mcp -- -k writes  → fails (tools absent)
Verify GREEN (after impl): same → passes against real mc-service.

The write tools are thin wrappers over mc-service POST endpoints that forward the user's
JWT; mc-service applies RBAC + DAC + uniqueness unchanged (FR-022). They carry an
`idempotencyKey` (basis of at-most-once — a duplicate add/create surfaces mc-service's
409 so the organizer's approval-time re-validation maps it to skipped_duplicate; the
underlying uniqueness constraint, not the key, guarantees one persisted change — SC-006).
Unauthorized/unreachable targets mirror mc-service (404 — feature 011 Clean DAC).
"""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest

from src.tools import add_movie, create_collection, list_movies, make_mc_client


def _movie_body(title: str) -> dict[str, object]:
    """A fully-populated MovieRequest (mc-service rejects missing non-Option fields)."""
    return {
        "title": title,
        "year": 1999,
        "contentType": "Movie",
        "language": "English",
        "owned": True,
        "ripped": False,
        "childrens": False,
        "ownedMedia": ["DVD"],
        "ripQuality": [],
        "genres": ["Sci-Fi"],
        "rated": "R",
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


@pytest.fixture
def temp_collection(mc_base_url: str, mc_token: str) -> Iterator[str]:
    """An isolated empty collection (created via raw REST) to write into; torn down after."""
    client = httpx.Client(
        base_url=mc_base_url,
        headers={"Authorization": f"Bearer {mc_token}", "Content-Type": "application/json"},
        timeout=15.0,
    )
    name = f"movie-mcp-write-it-{id(object())}"
    collection_id = ""
    try:
        r = client.post("/api/v1/collections", json={"name": name})
        r.raise_for_status()
        collection_id = r.json()["collectionId"]
        yield collection_id
    finally:
        if collection_id:
            client.delete(f"/api/v1/collections/{collection_id}")
        client.close()


@pytest.mark.asyncio
async def test_create_collection_creates_a_reachable_collection(
    mc_base_url: str, mc_token: str
) -> None:
    name = f"movie-mcp-create-it-{id(object())}"
    created: dict[str, object] = {}
    async with make_mc_client(mc_base_url, mc_token) as client:
        try:
            created = await create_collection(client, name=name, idempotency_key="k-create-1")
            assert created["collectionId"]
        finally:
            cid = created.get("collectionId")
            if cid:
                await client.delete(f"/api/v1/collections/{cid}")


@pytest.mark.asyncio
async def test_add_movie_persists_one_movie(
    mc_base_url: str, mc_token: str, temp_collection: str
) -> None:
    title = f"Write Probe {id(object())}"
    async with make_mc_client(mc_base_url, mc_token) as client:
        result = await add_movie(
            client, temp_collection, _movie_body(title), idempotency_key="k-add-1"
        )
        assert result["movieId"]

        page = await list_movies(client, temp_collection)
        titles = {m["title"] for m in page["items"]}
        assert title in titles


@pytest.mark.asyncio
async def test_duplicate_add_surfaces_mc_service_conflict(
    mc_base_url: str, mc_token: str, temp_collection: str
) -> None:
    # Per-collection movie uniqueness gives at-most-once: the second add of the same
    # movie surfaces mc-service's 4xx (the organizer maps it to skipped_duplicate).
    title = f"Dup Probe {id(object())}"
    async with make_mc_client(mc_base_url, mc_token) as client:
        await add_movie(client, temp_collection, _movie_body(title), idempotency_key="k-dup-1")
        with pytest.raises(httpx.HTTPStatusError) as excinfo:
            await add_movie(client, temp_collection, _movie_body(title), idempotency_key="k-dup-2")
    assert excinfo.value.response.status_code in (409, 422)


@pytest.mark.asyncio
async def test_add_movie_to_unreachable_collection_mirrors_404(
    mc_base_url: str, mc_token: str
) -> None:
    async with make_mc_client(mc_base_url, mc_token) as client:
        with pytest.raises(httpx.HTTPStatusError) as excinfo:
            await add_movie(
                client, "0123456789abcdef01234567", _movie_body("Nope"), idempotency_key="k-404"
            )
    assert excinfo.value.response.status_code == 404
