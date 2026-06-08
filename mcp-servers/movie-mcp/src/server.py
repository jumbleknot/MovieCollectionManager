"""movie-mcp MCP server: registers the read + write tools over streamable-HTTP.

Implements: T021 (read tools), T043/T051 (write tools). Each handler reads the per-request
downscoped `aud=mc-service` JWT from the request ContextVar (captured by
`TokenCaptureMiddleware` from the gateway's `Authorization` header — out-of-band, never an
LLM-visible arg, SC-004), builds an mc-service client, and calls the thin wrapper in
`tools.py`. No domain logic (FR-022); mc-service errors surface as MCP tool errors (FR-018).

Stateless streamable-HTTP so each tool call is an independent request carrying its own
per-call token. Attaches to backend-network in the container (must reach mc-service).
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

from src import tools
from src.context import TokenCaptureMiddleware, get_request_token

MC_SERVICE_URL = os.environ.get("MC_SERVICE_URL", "http://localhost:3001")

mcp = FastMCP("movie-mcp", stateless_http=True, json_response=True)


# ── Read tools (curator + organizer allowlist) ───────────────────────────────

@mcp.tool()
async def list_collections() -> list[dict[str, Any]]:
    """List the collections the user can reach (owned + shared)."""
    async with tools.make_mc_client(MC_SERVICE_URL, get_request_token()) as client:
        return await tools.list_collections(client)


@mcp.tool()
async def get_collection(collectionId: str) -> dict[str, Any]:  # noqa: N803 (MCP arg name)
    """Get a single collection (404 if not reachable — DAC parity)."""
    async with tools.make_mc_client(MC_SERVICE_URL, get_request_token()) as client:
        return await tools.get_collection(client, collectionId)


@mcp.tool()
async def list_movies(
    collectionId: str,  # noqa: N803 (MCP arg name)
    cursor: str | None = None,
    filter: dict[str, Any] | None = None,  # noqa: A002 (contract arg name)
) -> dict[str, Any]:
    """List a collection's movies (keyset page { items, nextCursor }); also re-validation."""
    async with tools.make_mc_client(MC_SERVICE_URL, get_request_token()) as client:
        return await tools.list_movies(client, collectionId, cursor=cursor, filters=filter)


# ── Write tools (organizer allowlist; HITL-gated; approved-resume path only) ──

@mcp.tool()
async def create_collection(name: str, idempotencyKey: str) -> dict[str, Any]:  # noqa: N803
    """Create a collection (create-if-missing target, FR-005a)."""
    async with tools.make_mc_client(MC_SERVICE_URL, get_request_token()) as client:
        try:
            return await tools.create_collection(client, name=name, idempotency_key=idempotencyKey)
        except httpx.HTTPStatusError as exc:
            # Surface the upstream status to the gateway (409 -> skipped_duplicate; FR-009a).
            raise tools.tool_error_from_http_status(exc) from exc


@mcp.tool()
async def add_movie(
    collectionId: str,  # noqa: N803
    movie: dict[str, Any],
    idempotencyKey: str,  # noqa: N803
) -> dict[str, Any]:
    """Add a movie to a collection (movie shaped from an EnrichedMovieCandidate)."""
    async with tools.make_mc_client(MC_SERVICE_URL, get_request_token()) as client:
        try:
            return await tools.add_movie(
                client, collectionId, movie, idempotency_key=idempotencyKey
            )
        except httpx.HTTPStatusError as exc:
            # Surface the upstream status to the gateway (409 -> skipped_duplicate; FR-009a).
            raise tools.tool_error_from_http_status(exc) from exc


@mcp.tool()
async def update_movie(
    collectionId: str,  # noqa: N803
    movieId: str,  # noqa: N803
    movie: dict[str, Any],
    idempotencyKey: str,  # noqa: N803
) -> dict[str, Any]:
    """Update a movie (full-replacement; `movie` is the complete payload)."""
    async with tools.make_mc_client(MC_SERVICE_URL, get_request_token()) as client:
        try:
            return await tools.update_movie(
                client, collectionId, movieId, movie, idempotency_key=idempotencyKey
            )
        except httpx.HTTPStatusError as exc:
            # Surface the upstream status (404 -> skipped_missing at approval time; FR-009a).
            raise tools.tool_error_from_http_status(exc) from exc


@mcp.tool()
async def delete_movie(
    collectionId: str,  # noqa: N803
    movieId: str,  # noqa: N803
    idempotencyKey: str,  # noqa: N803
) -> dict[str, Any]:
    """Delete a movie from a collection (hard delete)."""
    async with tools.make_mc_client(MC_SERVICE_URL, get_request_token()) as client:
        try:
            return await tools.delete_movie(
                client, collectionId, movieId, idempotency_key=idempotencyKey
            )
        except httpx.HTTPStatusError as exc:
            # Surface the upstream status (404 -> skipped_missing at approval time; FR-009a).
            raise tools.tool_error_from_http_status(exc) from exc


def build_app() -> Any:
    """Streamable-HTTP ASGI app wrapped with the per-request token-capture middleware."""
    return TokenCaptureMiddleware(mcp.streamable_http_app())


def main() -> None:
    """Container entrypoint — serve the streamable-HTTP app on backend-network."""
    import uvicorn

    host = os.environ.get("MC_MCP_HOST", "0.0.0.0")  # noqa: S104 (container bind)
    port = int(os.environ.get("MC_MCP_PORT", "8000"))
    uvicorn.run(build_app(), host=host, port=port)


if __name__ == "__main__":
    main()
