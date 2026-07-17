"""T035 — curator enrichment through the REAL MCP transport to web-api-mcp / TMDB.

Verify RED:  pnpm nx test:integration movie-assistant -- -k enrich  → fails (curator absent)
Verify GREEN: same → passes against a running web-api-mcp + real TMDB.

This is the first LIVE exercise of the Slice F2 streamable-HTTP transport end to end:
  enrich_movie → invoke_tool (curator allowlist + rate-limit + guard_tool_output)
              → call_mcp_tool (streamable-HTTP) → web-api-mcp server → real TMDB.
web-api-mcp carries no user token (outbound-only), so no downscoped-token step here.

Run a web-api-mcp server first (skips cleanly if unreachable, like the other real-stack
integration tests):
  cd mcp-servers/web-api-mcp && WEB_API_MCP_PORT=8765 TMDB_API_KEY=... \
      uv run python -m src.server
  WEB_API_MCP_URL=http://127.0.0.1:8765/mcp pnpm nx test:integration movie-assistant -- -k enrich
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from src.nodes.curator import enrich_movie
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.mcp_tools import McpServerConfig, call_mcp_tool, invoke_tool, list_mcp_tools

WEB_API_MCP_URL = os.environ.get("WEB_API_MCP_URL", "http://127.0.0.1:8765/mcp")
WEB = McpServerConfig(name="web-api-mcp", url=WEB_API_MCP_URL, needs_token=False)


async def _require_web_api_mcp() -> None:
    try:
        await list_mcp_tools(WEB_API_MCP_URL)
    except Exception as exc:  # noqa: BLE001 — any connect/transport failure ⇒ skip
        pytest.skip(f"web-api-mcp not reachable at {WEB_API_MCP_URL}: {exc}")


def _enrichers() -> tuple[Any, Any]:
    limiter = AgentToolRateLimiter(max_calls=100, window_seconds=60)

    async def _no_token(_subject: str, _audience: str) -> str:
        return ""  # never called: web-api-mcp needs no token

    async def search(query: str, year: int | None) -> dict[str, Any]:
        args: dict[str, Any] = {"query": query}
        if year is not None:
            args["year"] = year
        out = await invoke_tool(
            agent="curator", tool_name="search_title", arguments=args, server=WEB,
            subject_token=None, call=call_mcp_tool, limiter=limiter, acquire_token=_no_token,
        )
        assert out.ok, out.error
        return out.data

    async def details(source_id: str) -> dict[str, Any]:
        out = await invoke_tool(
            agent="curator", tool_name="get_movie_details", arguments={"sourceId": source_id},
            server=WEB, subject_token=None, call=call_mcp_tool, limiter=limiter,
            acquire_token=_no_token,
        )
        assert out.ok, out.error
        return out.data

    return search, details


# ci_quarantine (TMDB bucket): web-api-mcp returns "That request couldn't be completed" on the live
# TMDB call in CI (transport 200 OK, TMDB call inside fails). Needs live investigation of the
# container's TMDB key/egress. Tracked in project_mcm_agent_integration_ci.
@pytest.mark.ci_quarantine
@pytest.mark.asyncio
async def test_curator_surfaces_known_title_via_real_web_api_mcp() -> None:
    # Real TMDB returns several "The Matrix" titles, so the curator correctly resolves
    # ambiguous (offer options, never fabricate) — or exact if a single match. Either way
    # the transport works and tmdb:603 surfaces (as the candidate, or among the options).
    await _require_web_api_mcp()
    search, details = _enrichers()

    result = await enrich_movie("The Matrix", 1999, search=search, details=details)

    assert result.confidence in {"exact", "ambiguous"}
    if result.confidence == "exact":
        assert result.candidate is not None
        assert result.candidate.source_id == "tmdb:603"
    else:
        assert any(o.get("sourceId") == "tmdb:603" for o in result.options)


@pytest.mark.ci_quarantine  # TMDB bucket — see project_mcm_agent_integration_ci
@pytest.mark.asyncio
async def test_curator_details_leg_builds_exact_candidate_via_real_web_api_mcp() -> None:
    # The exact-candidate leg: get_movie_details through the transport → EnrichedMovieCandidate.
    await _require_web_api_mcp()
    _search, details = _enrichers()

    detail = await details("tmdb:603")

    assert detail["title"] == "The Matrix"
    assert detail["year"] == 1999
    assert detail["source"] == "tmdb"


@pytest.mark.ci_quarantine  # TMDB bucket — see project_mcm_agent_integration_ci
@pytest.mark.asyncio
async def test_curator_no_match_returns_none_via_real_web_api_mcp() -> None:
    await _require_web_api_mcp()
    search, details = _enrichers()

    result = await enrich_movie(
        "zzzqqxxnotarealmovietitle12345", None, search=search, details=details
    )

    assert result.confidence == "none"
    assert result.candidate is None
