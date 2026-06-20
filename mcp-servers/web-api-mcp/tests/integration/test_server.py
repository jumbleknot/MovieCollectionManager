"""T022 — web-api-mcp MCP SERVER (tool registration) over the real TMDB API, exercised
through an in-memory MCP client/server session.

Verify RED:  pnpm nx test:integration web-api-mcp -- -k server  → fails (server absent)
Verify GREEN (after impl + a TMDB_API_KEY): same → passes against real TMDB.

web-api-mcp is outbound-only and carries NO per-user token (it uses its own TMDB key from
the environment) — so, unlike movie-mcp, there is no Authorization middleware here. Stable
facts about TMDB id 603 (The Matrix, 1999). Tool errors surface as MCP tool errors (FR-018).
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from mcp.shared.memory import create_connected_server_and_client_session
from mcp.types import CallToolResult

from src import server
from src.server import mcp


def _payload(result: CallToolResult) -> Any:
    if result.structuredContent is not None:
        sc = result.structuredContent
        return sc["result"] if isinstance(sc, dict) and set(sc) == {"result"} else sc
    return json.loads(result.content[0].text)  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_server_search_title_finds_matrix(tmdb_api_key: str) -> None:
    # Supply the key the way production does — as the per-request key (the X-TMDB-Key ContextVar) —
    # NOT via env: there is no shared env/Vault fallback (per-user credentials only). Set before
    # the session is created so its task inherits the context.
    token = server._request_tmdb_key.set(tmdb_api_key)
    try:
        async with create_connected_server_and_client_session(mcp) as session:
            result = await session.call_tool("search_title", {"query": "The Matrix", "year": 1999})
    finally:
        server._request_tmdb_key.reset(token)
    assert not result.isError
    ids = {r["sourceId"] for r in _payload(result)["results"]}
    assert "tmdb:603" in ids


@pytest.mark.asyncio
async def test_server_get_movie_details_returns_enriched_candidate(tmdb_api_key: str) -> None:
    token = server._request_tmdb_key.set(tmdb_api_key)
    try:
        async with create_connected_server_and_client_session(mcp) as session:
            result = await session.call_tool("get_movie_details", {"sourceId": "tmdb:603"})
    finally:
        server._request_tmdb_key.reset(token)
    assert not result.isError
    payload = _payload(result)
    assert payload["title"] == "The Matrix"
    assert payload["year"] == 1999
    assert payload["source"] == "tmdb"
