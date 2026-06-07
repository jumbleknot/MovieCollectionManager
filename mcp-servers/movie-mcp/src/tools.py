"""movie-mcp tools — thin wrappers over mc-service REST (no domain logic).

Contract: specs/012-multi-agent-mvp/contracts/movie-mcp-tools.md.
Reads (T021): get_collection, list_movies, list_collections.
Writes (T043: add_movie, create_collection; T051: update_movie, delete_movie) — carry
an idempotency key, executed only on the approved-resume path.

Every call forwards the gateway-exchanged downscoped (aud=mc-service) JWT as
`Authorization: Bearer`; mc-service enforces RBAC + DAC unchanged (unauthorized -> 404,
mirroring the direct API — feature 011 Clean DAC). These wrappers introduce NO domain
logic (FR-022): they surface mc-service's response shapes verbatim and let mc-service's
HTTP errors propagate (the MCP server layer maps them to structured tool errors). No token
is ever logged.
"""

from __future__ import annotations

from typing import Any

import httpx

_API = "/api/v1"


def make_mc_client(base_url: str, token: str) -> httpx.AsyncClient:
    """Build an httpx client bound to mc-service, carrying the user's downscoped JWT.

    The caller owns the lifetime (use `async with make_mc_client(...) as client:`). The
    token is the gateway-exchanged `aud=mc-service` JWT — the subject token never reaches
    movie-mcp, and the token is never logged.
    """
    return httpx.AsyncClient(
        base_url=base_url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=15.0,
    )


async def list_collections(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    """GET /api/v1/collections — collections the user can reach (owned + shared)."""
    resp = await client.get(f"{_API}/collections")
    resp.raise_for_status()
    data: list[dict[str, Any]] = resp.json()
    return data


async def get_collection(client: httpx.AsyncClient, collection_id: str) -> dict[str, Any]:
    """GET /api/v1/collections/{collectionId} — a single collection (404 if not reachable)."""
    resp = await client.get(f"{_API}/collections/{collection_id}")
    resp.raise_for_status()
    data: dict[str, Any] = resp.json()
    return data


async def list_movies(
    client: httpx.AsyncClient,
    collection_id: str,
    cursor: str | None = None,
    filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """GET /api/v1/collections/{collectionId}/movies — keyset page { items, nextCursor }.

    `cursor` is mc-service's opaque base64 ObjectId (omit for the first page). `filters`
    passes structural query params (search/genre/decade/owned/...) straight through;
    movie-mcp adds no filtering of its own.
    """
    params: dict[str, Any] = dict(filters) if filters else {}
    if cursor:
        params["cursor"] = cursor
    resp = await client.get(f"{_API}/collections/{collection_id}/movies", params=params)
    resp.raise_for_status()
    data: dict[str, Any] = resp.json()
    return data
