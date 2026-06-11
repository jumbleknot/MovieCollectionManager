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

from src.server import mcp


def _payload(result: CallToolResult) -> Any:
    if result.structuredContent is not None:
        sc = result.structuredContent
        return sc["result"] if isinstance(sc, dict) and set(sc) == {"result"} else sc
    return json.loads(result.content[0].text)  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_server_search_title_finds_matrix(
    tmdb_api_key: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TMDB_API_KEY", tmdb_api_key)
    async with create_connected_server_and_client_session(mcp) as session:
        result = await session.call_tool("search_title", {"query": "The Matrix", "year": 1999})
    assert not result.isError
    ids = {r["sourceId"] for r in _payload(result)["results"]}
    assert "tmdb:603" in ids


@pytest.mark.asyncio
async def test_server_get_movie_details_returns_enriched_candidate(
    tmdb_api_key: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TMDB_API_KEY", tmdb_api_key)
    async with create_connected_server_and_client_session(mcp) as session:
        result = await session.call_tool("get_movie_details", {"sourceId": "tmdb:603"})
    assert not result.isError
    payload = _payload(result)
    assert payload["title"] == "The Matrix"
    assert payload["year"] == 1999
    assert payload["source"] == "tmdb"
