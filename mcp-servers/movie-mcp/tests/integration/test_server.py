"""T043/T021 — movie-mcp MCP SERVER (tool registration + per-request token) over the
real mc-service, exercised through an in-memory MCP client/server session.

Verify RED:  pnpm nx test:integration movie-mcp -- -k server  → fails (server absent)
Verify GREEN (after impl): same → passes.

The gateway reaches movie-mcp over streamable-HTTP and supplies the downscoped
`aud=mc-service` JWT out-of-band as the request `Authorization` header (never an
LLM-visible tool arg — SC-004); a pure-ASGI middleware captures it into a ContextVar that
the tool handlers read. Here we drive the FastMCP server through the SDK's in-memory
client session and set that ContextVar directly (simulating the middleware), proving the
tools are registered and call real mc-service with the request-scoped token. The middleware
itself is unit-tested separately. Tool errors surface as MCP tool errors (isError), not
exceptions (FR-018).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from mcp.shared.memory import create_connected_server_and_client_session
from mcp.types import CallToolResult

from src.context import set_request_token
from src.server import mcp


def _payload(result: CallToolResult) -> Any:
    """Extract the structured dict/list a tool returned (structuredContent or JSON text)."""
    if result.structuredContent is not None:
        sc = result.structuredContent
        # FastMCP wraps a non-dict return under {"result": ...}; unwrap that.
        return sc["result"] if isinstance(sc, dict) and set(sc) == {"result"} else sc
    return json.loads(result.content[0].text)  # type: ignore[union-attr]


def _movie_body(title: str) -> dict[str, Any]:
    return {
        "title": title, "year": 1999, "contentType": "Movie", "language": "English",
        "owned": True, "ripped": False, "childrens": False, "ownedMedia": ["DVD"],
        "ripQuality": [], "genres": ["Sci-Fi"], "rated": "R", "directors": [], "actors": [],
        "tags": [], "movieSet": None, "originalTitle": None, "releaseDate": None,
        "outline": None, "plot": None, "runtime": None, "externalIds": [],
    }


@pytest.fixture
def temp_collection(mc_base_url: str, mc_token: str) -> Iterator[str]:
    client = httpx.Client(
        base_url=mc_base_url,
        headers={"Authorization": f"Bearer {mc_token}", "Content-Type": "application/json"},
        timeout=15.0,
    )
    name = f"movie-mcp-server-it-{id(object())}"
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
async def test_server_list_collections_uses_request_token(
    mc_token: str, seeded_collection: dict[str, str]
) -> None:
    set_request_token(mc_token)  # the ASGI middleware does this per request in production
    async with create_connected_server_and_client_session(mcp) as session:
        result = await session.call_tool("list_collections", {})
    assert not result.isError
    collections = _payload(result)
    ids = {c["collectionId"] for c in collections}
    assert seeded_collection["collectionId"] in ids


@pytest.mark.asyncio
async def test_server_get_collection_returns_seeded(
    mc_token: str, seeded_collection: dict[str, str]
) -> None:
    set_request_token(mc_token)
    async with create_connected_server_and_client_session(mcp) as session:
        result = await session.call_tool(
            "get_collection", {"collectionId": seeded_collection["collectionId"]}
        )
    assert not result.isError
    assert _payload(result)["name"] == seeded_collection["name"]


@pytest.mark.asyncio
async def test_server_add_movie_persists(mc_token: str, temp_collection: str) -> None:
    title = f"MCP Server Add {id(object())}"
    set_request_token(mc_token)
    async with create_connected_server_and_client_session(mcp) as session:
        add = await session.call_tool(
            "add_movie",
            {"collectionId": temp_collection, "movie": _movie_body(title),
             "idempotencyKey": "k-server-1"},
        )
        assert not add.isError
        listed = await session.call_tool("list_movies", {"collectionId": temp_collection})
    titles = {m["title"] for m in _payload(listed)["items"]}
    assert title in titles


@pytest.mark.asyncio
async def test_server_unreachable_collection_is_tool_error_not_exception(
    mc_token: str,
) -> None:
    set_request_token(mc_token)
    async with create_connected_server_and_client_session(mcp) as session:
        result = await session.call_tool(
            "get_collection", {"collectionId": "0123456789abcdef01234567"}
        )
    # mc-service's 404 (DAC parity) surfaces as a structured MCP tool error (FR-018).
    assert result.isError
