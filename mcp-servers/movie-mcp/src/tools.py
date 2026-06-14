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


class McServiceToolError(RuntimeError):
    """An mc-service HTTP error surfaced as an MCP tool error, carrying the upstream status.

    Raised at the server layer (T024a) so the gateway's `invoke_tool` can classify the outcome
    (e.g. 409 -> skipped_duplicate, 5xx -> retry) from the MCP error text via the stable
    `mc-service-status:<code>` sentinel — without parsing mc-service's body. No token or PII is
    included (SC-004 / FR-022): only the status code travels.
    """

    def __init__(self, status_code: int, detail: str = "") -> None:
        self.status_code = status_code
        self.detail = detail
        message = f"mc-service-status:{status_code}"
        if detail:
            message = f"{message} {detail}"
        super().__init__(message)


# Statuses whose mc-service problem+json `detail` is a fixed, non-sensitive INPUT-VALIDATION
# message (e.g. "Year must be a 4-digit number") safe to surface so the agent can report WHY a
# write was rejected. Other statuses carry only the code (no body) to avoid leaking anything.
_DETAIL_STATUSES = frozenset({400, 422})


def tool_error_from_http_status(exc: httpx.HTTPStatusError) -> McServiceToolError:
    """Map an httpx 4xx/5xx from mc-service into a status-bearing MCP tool error.

    For client-validation statuses (400/422) the problem+json `detail` is appended after the
    `mc-service-status:<code>` sentinel so the import report can show the field-level reason; all
    other statuses carry only the code (no body / no PII).
    """
    detail = ""
    if exc.response.status_code in _DETAIL_STATUSES:
        try:
            body = exc.response.json()
            detail = str(body.get("detail") or body.get("title") or "").strip()
        except (ValueError, TypeError):
            detail = ""
    return McServiceToolError(exc.response.status_code, detail)


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


async def count_movies(
    client: httpx.AsyncClient,
    collection_id: str,
    filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """GET /api/v1/collections/{collectionId}/movies/count — server-side count `{ count }`.

    `filters` passes the same structural params as `list_movies` (search/genre/decade/owned/...);
    the pagination cursor is not applicable (count is the total). movie-mcp adds no logic of its
    own — the count is computed efficiently by mc-service (US4 / FR-023).
    """
    params: dict[str, Any] = dict(filters) if filters else {}
    resp = await client.get(f"{_API}/collections/{collection_id}/movies/count", params=params)
    resp.raise_for_status()
    data: dict[str, Any] = resp.json()
    return data


# ── Write tools (organizer only; HITL-gated; executed on the approved-resume path) ──
#
# Each carries an `idempotency_key`, forwarded as a standard `Idempotency-Key` header.
# mc-service is unchanged (FR-022) and ignores the header today; at-most-once is provided
# by mc-service's own uniqueness constraints (per-collection movie, per-owner collection
# name) — a duplicate add/create surfaces mc-service's 4xx, which the organizer maps to
# skipped_duplicate at approval-time re-validation (FR-009a, SC-006). The header keeps the
# contract signature and is forward-compatible if mc-service ever honours it. No token logged.


async def create_collection(
    client: httpx.AsyncClient, name: str, idempotency_key: str
) -> dict[str, Any]:
    """POST /api/v1/collections — create-if-missing target (FR-005a). Returns mc-service's shape."""
    resp = await client.post(
        f"{_API}/collections", json={"name": name}, headers={"Idempotency-Key": idempotency_key}
    )
    resp.raise_for_status()
    data: dict[str, Any] = resp.json()
    return data


async def add_movie(
    client: httpx.AsyncClient,
    collection_id: str,
    movie: dict[str, Any],
    idempotency_key: str,
) -> dict[str, Any]:
    """POST /api/v1/collections/{collectionId}/movies — `movie` from an EnrichedMovieCandidate.

    Surfaces mc-service's response/errors verbatim (404 if the collection is unreachable —
    DAC parity; 4xx on duplicate — at-most-once basis). No domain remapping (FR-022).
    """
    resp = await client.post(
        f"{_API}/collections/{collection_id}/movies",
        json=movie,
        headers={"Idempotency-Key": idempotency_key},
    )
    resp.raise_for_status()
    data: dict[str, Any] = resp.json()
    return data


async def update_movie(
    client: httpx.AsyncClient,
    collection_id: str,
    movie_id: str,
    movie: dict[str, Any],
    idempotency_key: str,
) -> dict[str, Any]:
    """PUT /api/v1/collections/{collectionId}/movies/{movieId} — full-replacement update.

    mc-service PUT replaces the whole movie, so `movie` is the COMPLETE payload (the organizer
    composes it from a read + the requested changes — no merge logic here, FR-022). A missing
    movie surfaces mc-service's 404 (organizer → skipped_missing at approval time, FR-009a).
    """
    resp = await client.put(
        f"{_API}/collections/{collection_id}/movies/{movie_id}",
        json=movie,
        headers={"Idempotency-Key": idempotency_key},
    )
    resp.raise_for_status()
    data: dict[str, Any] = resp.json()
    return data


async def delete_movie(
    client: httpx.AsyncClient,
    collection_id: str,
    movie_id: str,
    idempotency_key: str,
) -> dict[str, Any]:
    """DELETE /api/v1/collections/{collectionId}/movies/{movieId} — hard delete.

    Returns `{ movieId, deleted: true }`. A missing movie surfaces mc-service's 404 (organizer
    → skipped_missing at approval time, FR-009a). mc-service handles a 204/empty body.
    """
    resp = await client.delete(
        f"{_API}/collections/{collection_id}/movies/{movie_id}",
        headers={"Idempotency-Key": idempotency_key},
    )
    resp.raise_for_status()
    if resp.status_code == 204 or not resp.content:
        return {"movieId": movie_id, "deleted": True}
    data: dict[str, Any] = resp.json()
    data.setdefault("movieId", movie_id)
    data.setdefault("deleted", True)
    return data
