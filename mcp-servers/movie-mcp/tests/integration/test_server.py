"""T043/T021 — movie-mcp MCP SERVER (tool registration + per-request token) over the
real mc-service, exercised through an in-memory MCP client/server session.

Verify RED:  pnpm nx test:integration movie-mcp -- -k server  → fails (server absent)
Verify GREEN (after impl): same → passes.

The gateway reaches movie-mcp over streamable-HTTP and supplies the downscoped
`aud=mc-service` JWT out-of-band as the request `Authorization` header (never an
LLM-visible tool arg — SC-004); a pure-ASGI middleware captures it into a ContextVar that
the tool handlers read. Here we drive the MCPServer through the SDK's public in-memory
client session and set that ContextVar directly (simulating the middleware), proving the
tools are registered and call real mc-service with the request-scoped token. The middleware
itself is unit-tested separately. Tool errors surface as MCP tool errors (is_error), not
exceptions (FR-018).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from mcp.client import Client
from mcp.types import CallToolResult

from src.context import set_request_token
from src.server import mcp


def _payload(result: CallToolResult) -> Any:
    """Extract the structured dict/list a tool returned (structured_content or JSON text)."""
    if result.structured_content is not None:
        sc = result.structured_content
        # A sequence-returning tool is wrapped under {"result": ...} (2.x, as 1.x); unwrap.
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
    async with Client(mcp) as session:
        result = await session.call_tool("list_collections", {})
    assert not result.is_error
    collections = _payload(result)
    ids = {c["collectionId"] for c in collections}
    assert seeded_collection["collectionId"] in ids


@pytest.mark.asyncio
async def test_server_get_collection_returns_seeded(
    mc_token: str, seeded_collection: dict[str, str]
) -> None:
    set_request_token(mc_token)
    async with Client(mcp) as session:
        result = await session.call_tool(
            "get_collection", {"collectionId": seeded_collection["collectionId"]}
        )
    assert not result.is_error
    assert _payload(result)["name"] == seeded_collection["name"]


@pytest.mark.asyncio
async def test_server_add_movie_persists(mc_token: str, temp_collection: str) -> None:
    title = f"MCP Server Add {id(object())}"
    set_request_token(mc_token)
    async with Client(mcp) as session:
        add = await session.call_tool(
            "add_movie",
            {"collectionId": temp_collection, "movie": _movie_body(title),
             "idempotencyKey": "k-server-1"},
        )
        assert not add.is_error
        listed = await session.call_tool("list_movies", {"collectionId": temp_collection})
    titles = {m["title"] for m in _payload(listed)["items"]}
    assert title in titles


@pytest.mark.asyncio
async def test_server_unreachable_collection_is_tool_error_not_exception(
    mc_token: str,
) -> None:
    set_request_token(mc_token)
    async with Client(mcp) as session:
        result = await session.call_tool(
            "get_collection", {"collectionId": "0123456789abcdef01234567"}
        )
    # mc-service's 404 (DAC parity) surfaces as a structured MCP tool error (FR-018).
    assert result.is_error

    # No status sentinel is asserted here on purpose: the READ tools let httpx.HTTPStatusError
    # propagate raw, so `mc-service-status:<code>` was never produced on this path on 1.x either.
    # The sentinel belongs to the WRITE tools — see the boundary test at the end of this module.


# ── Structured-content semantics across the 1.x -> 2.x boundary (feature 068) ──────────────────
# Contract: specs/068-mcp-2x-migration/contracts/mcp-tool-result.md INV-1/INV-2.
#
# These were only ever asserted implicitly, via _payload() happening to work. They are the contract
# the SDK major must not shift, and one annotation shape silently breaks them: a bare `dict` return
# yields structured_content None on 2.x, so the assistant would receive text only with nothing
# failing. scripts/__tests__/mcp-tool-annotations.guard.test.mjs keeps the annotations precise;
# these two assert the behaviour that precision buys.


@pytest.mark.asyncio
async def test_server_mapping_tool_returns_its_mapping_unwrapped(
    mc_token: str, seeded_collection: dict[str, str]
) -> None:
    """A tool declared `-> dict[str, Any]` puts the mapping in structured_content AS-IS (INV-1)."""
    set_request_token(mc_token)
    async with Client(mcp) as session:
        result = await session.call_tool(
            "get_collection", {"collectionId": seeded_collection["collectionId"]}
        )
    assert not result.is_error
    assert isinstance(result.structured_content, dict)
    # Not wrapped: the payload's own keys are at the top level, so no {"result": ...} envelope.
    assert set(result.structured_content) != {"result"}
    assert result.structured_content["name"] == seeded_collection["name"]


@pytest.mark.asyncio
async def test_server_sequence_tool_is_wrapped_under_result(
    mc_token: str, seeded_collection: dict[str, str]
) -> None:
    """A tool declared `-> list[dict[str, Any]]` is wrapped under a single `result` key (INV-2).

    The gateway's _to_call_result() and this suite's _payload() both unwrap exactly this shape, so
    the unwrap must not be "simplified away" during the migration.
    """
    set_request_token(mc_token)
    async with Client(mcp) as session:
        result = await session.call_tool("list_collections", {})
    assert not result.is_error
    assert isinstance(result.structured_content, dict)
    assert set(result.structured_content) == {"result"}
    assert isinstance(result.structured_content["result"], list)


@pytest.mark.asyncio
async def test_write_error_sentinel_survives_the_mcp_boundary(
    mc_token: str, temp_collection: str
) -> None:
    """A write tool's `mc-service-status:<code>` must reach the caller THROUGH the MCP boundary.

    Feature 068. Nothing asserted this before, and its absence is what let a real regression ship:
    every existing check either asserted only `is_error`, or called the tool function directly and
    never crossed the boundary at all.

    mcp 2.x withholds the message of any exception it treats as a CRASH (`UnexpectedToolError` ->
    a bare "Error executing tool <name>"), preserving it only for a deliberately raised `ToolError`.
    `McServiceToolError` was a plain RuntimeError, so it fell on the crash side and the sentinel was
    dropped. The gateway classifies outcomes from that sentinel — 409 -> skipped_duplicate,
    5xx -> retry, 400/422 -> field-level reason — so all three degraded to a generic failure while
    this suite stayed green.
    """
    title = f"MCP Boundary Dup {id(object())}"
    set_request_token(mc_token)
    async with Client(mcp) as session:
        body = _movie_body(title)
        first = await session.call_tool(
            "add_movie",
            {"collectionId": temp_collection, "movie": body, "idempotencyKey": "k-b-1"},
        )
        assert not first.is_error, _payload(first)
        second = await session.call_tool(
            "add_movie",
            {"collectionId": temp_collection, "movie": body, "idempotencyKey": "k-b-2"},
        )

    assert second.is_error
    text = " ".join(c.text for c in second.content if getattr(c, "type", None) == "text")
    assert "mc-service-status:" in text, (
        f"the status sentinel did not survive the MCP boundary: {text!r} — the gateway cannot "
        f"classify 409/5xx/422 outcomes without it."
    )
