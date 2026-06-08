"""T051 — movie-mcp update_movie + delete_movie against the REAL mc-service.

Verify RED:  pnpm nx test:integration movie-mcp -- -k update_delete  → fails (tools absent)
Verify GREEN (after impl): same → passes against real mc-service.

Thin wrappers over mc-service `PUT`/`DELETE` movie endpoints (full-replacement update;
hard delete), forwarding the user's downscoped JWT (FR-022). Each carries an `idempotencyKey`.
A missing movie mirrors mc-service's 404 (the organizer maps it to skipped_missing at
approval-time re-validation — FR-009a). No domain logic here.
"""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest

from src.tools import add_movie, delete_movie, list_movies, make_mc_client, update_movie


def _movie_body(title: str, *, rated: str = "R") -> dict[str, object]:
    """A fully-populated MovieRequest (mc-service PUT is a full replacement — all fields)."""
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
        "rated": rated,
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
    """An isolated empty collection to write into; torn down after."""
    client = httpx.Client(
        base_url=mc_base_url,
        headers={"Authorization": f"Bearer {mc_token}", "Content-Type": "application/json"},
        timeout=15.0,
    )
    name = f"movie-mcp-upd-it-{id(object())}"
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
async def test_update_movie_replaces_fields(
    mc_base_url: str, mc_token: str, temp_collection: str
) -> None:
    title = f"Update Probe {id(object())}"
    async with make_mc_client(mc_base_url, mc_token) as client:
        added = await add_movie(
            client, temp_collection, _movie_body(title, rated="R"), idempotency_key="k-u-add"
        )
        movie_id = added["movieId"]

        await update_movie(
            client,
            temp_collection,
            movie_id,
            _movie_body(title, rated="PG-13"),
            idempotency_key="k-upd-1",
        )

        page = await list_movies(client, temp_collection)
        updated = next(m for m in page["items"] if m["movieId"] == movie_id)
        assert updated["rated"] == "PG-13"


@pytest.mark.asyncio
async def test_delete_movie_removes_it(
    mc_base_url: str, mc_token: str, temp_collection: str
) -> None:
    title = f"Delete Probe {id(object())}"
    async with make_mc_client(mc_base_url, mc_token) as client:
        added = await add_movie(
            client, temp_collection, _movie_body(title), idempotency_key="k-d-add"
        )
        movie_id = added["movieId"]

        result = await delete_movie(client, temp_collection, movie_id, idempotency_key="k-del-1")
        assert result.get("movieId") == movie_id

        page = await list_movies(client, temp_collection)
        assert movie_id not in {m["movieId"] for m in page["items"]}


@pytest.mark.asyncio
async def test_update_missing_movie_mirrors_404(
    mc_base_url: str, mc_token: str, temp_collection: str
) -> None:
    async with make_mc_client(mc_base_url, mc_token) as client:
        with pytest.raises(httpx.HTTPStatusError) as excinfo:
            await update_movie(
                client,
                temp_collection,
                "0123456789abcdef01234567",
                _movie_body("Nope"),
                idempotency_key="k-upd-404",
            )
    assert excinfo.value.response.status_code == 404


@pytest.mark.asyncio
async def test_delete_missing_movie_mirrors_404(
    mc_base_url: str, mc_token: str, temp_collection: str
) -> None:
    async with make_mc_client(mc_base_url, mc_token) as client:
        with pytest.raises(httpx.HTTPStatusError) as excinfo:
            await delete_movie(
                client, temp_collection, "0123456789abcdef01234567", idempotency_key="k-del-404"
            )
    assert excinfo.value.response.status_code == 404
