"""T100 §4b step 9 — the metadata read fails, and ONLY it (047 US4 / RQ-4).

The quickstart says "stop mc-service (or make the tool fail)". Stopping mc-service is the wrong
instrument: it kills the WRITE too, so the add fails for an unrelated reason and the property under
test — does the assistant skip the format question rather than guess? — is never exercised. That is
why an earlier session left this step unticked rather than claim it.

This fails ONLY `get_movie_metadata`, at the transport, against the otherwise-live stack. Everything
else is real: real movie-mcp, real mc-service writes, real Keycloak token exchange.

The property is load-bearing for RQ-4. The accepted media formats are DOMAIN data published by
mc-service; if the assistant ever fell back to a hardcoded list when the read failed, it would put
domain values back in the agent while LOOKING like resilience — the exact thing RQ-4 rejected.
"""

from __future__ import annotations

import os
import uuid
from typing import Any

import httpx
import pytest
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src.graph import build_graph
from src.runtime_nodes import RuntimeNodeConfig, build_runtime_nodes
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.mcp_tools import McpCallResult, call_mcp_tool, list_mcp_tools
from src.tools.token_exchange import reexchange_for_mc_service

MOVIE_MCP_URL = "http://127.0.0.1:8766/mcp"
WEB_API_MCP_URL = "http://127.0.0.1:8765/mcp"
_API = "/api/v1"


async def _fail_only_metadata(
    url: str, tool_name: str, arguments: dict[str, Any], token: str | None
) -> McpCallResult:
    if tool_name == "get_movie_metadata":
        return McpCallResult(is_error=True, data=None, text="mc-service-status:503 unavailable")
    return await call_mcp_tool(url, tool_name, arguments, token)


@pytest.mark.asyncio
async def test_metadata_unavailable_skips_the_question_and_still_completes_the_add(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    for url in (MOVIE_MCP_URL, WEB_API_MCP_URL):
        try:
            await list_mcp_tools(url)
        except Exception as exc:  # noqa: BLE001
            pytest.skip(f"MCP server not reachable at {url}: {exc}")

    # The metadata read is backed by a PROCESS-WIDE cache with a TTL (intentional — the response
    # is a domain enum with no user data). Any earlier test in the suite that fetched it warms that
    # cache, and the fault injected below is then never consulted: this test passed in isolation
    # and failed in the full run, which is exactly the shape that gets dismissed as flake and
    # re-run until green. Clear it so the test is hermetic either way.
    import src.runtime_nodes as _rn

    _rn._movie_metadata_cache = None
    _rn._movie_metadata_cached_at = 0.0

    tok = (await reexchange_for_mc_service(subject_token, env=reexchange_env)).token
    name = f"t100-meta-{uuid.uuid4().hex[:8]}"
    async with httpx.AsyncClient(base_url="http://localhost:3001",
                                 headers={"Authorization": f"Bearer {tok}"}, timeout=20) as c:
        cid = (await c.post(f"{_API}/collections", json={"name": name})).json()["collectionId"]

    async def authorize(_u: str, _a: str) -> bool:
        return True

    async def exchange(s: str) -> Any:
        return await reexchange_for_mc_service(s, env=reexchange_env)

    cfg = RuntimeNodeConfig(
        web_api_mcp_url=WEB_API_MCP_URL, movie_mcp_url=MOVIE_MCP_URL,
        limiter=AgentToolRateLimiter(max_calls=500, window_seconds=60),
        cache=DownscopedTokenCache(), authorize=authorize, exchange=exchange,
        call=_fail_only_metadata,
        extract=lambda _m: {"title": "Coherence", "year": 2013, "collection": name},
    )
    graph = build_graph(classifier=lambda _m: "add", checkpointer=MemorySaver(),
                        **build_runtime_nodes(cfg))
    # The curator enriches via REAL web-api-mcp, which forwards the CALLER's own TMDB v3 key —
    # there is no shared env fallback (FR-021). Without it there is no candidate, no proposal, and
    # no ownership question, so the property under test is never reached.
    tmdb_key = os.environ.get("TMDB_API_KEY", "")
    if not tmdb_key:
        pytest.skip("TMDB_API_KEY not set — the curator cannot enrich, so the add never starts")
    config = {
        "configurable": {
            "thread_id": name,
            "subject_token": subject_token,
            "user_id": "u",
            "agent_config": {"tmdbKey": tmdb_key},
        }
    }

    try:
        # Turn 1: 059 US2 — the chain opens by asking whether it is a children's movie.
        first = await graph.ainvoke(
            {"messages": [("user", f"add Coherence (2013) to {name}")]}, config
        )
        assert str(first.get("add_stage") or "") == "awaiting_childrens", (
            f"expected the children's question, got stage={first.get('add_stage')!r}"
        )

        # Turn 2: answered, the ownership question follows. Asserted by name — this test needs
        # to REACH the ownership question, and a walk that accepted any stage could sail past it
        # and then "pass" without ever exercising the metadata failure it exists to test.
        ownership = await graph.ainvoke({"messages": [("user", "no")]}, config)
        assert str(ownership.get("add_stage") or "") == "awaiting_ownership", (
            f"expected the ownership question, got stage={ownership.get('add_stage')!r}"
        )

        # Answer YES — which is what normally triggers the media-format question.
        owned = await graph.ainvoke({"messages": [("user", "yes")]}, config)

        stage = str(owned.get("add_stage") or "")
        assert stage != "awaiting_media", (
            "the format question was asked even though get_movie_metadata failed — the only way to "
            "populate it would be a hardcoded list, which is what RQ-4 rejected"
        )

        # And no guessed list may be offered anywhere in that turn.
        for message in owned.get("messages") or []:
            for call in getattr(message, "tool_calls", None) or []:
                args = call.get("args") or {}
                options = [str(o.get("label") or o.get("value") or "") for o in
                           (args.get("options") or [])]
                for fmt in ("DVD", "Blu-Ray", "Blu-Ray 3D", "UHD Blu-Ray"):
                    assert fmt not in options, (
                        f"offered a GUESSED media-format list {options} with the metadata read "
                        "failing — domain values must never originate in the agent (RQ-4)"
                    )

        # The add still completes and the movie is written, with no formats recorded.
        if "__interrupt__" in owned:
            owned = await graph.ainvoke(Command(resume={"decision": "approved"}), config)
        else:
            for _ in range(4):
                st = str(owned.get("add_stage") or "")
                if not st:
                    break
                owned = await graph.ainvoke({"messages": [("user", "no")]}, config)
                if "__interrupt__" in owned:
                    owned = await graph.ainvoke(Command(resume={"decision": "approved"}), config)
                    break

        async with httpx.AsyncClient(base_url="http://localhost:3001",
                                     headers={"Authorization": f"Bearer {tok}"}, timeout=20) as c:
            movies = (await c.get(f"{_API}/collections/{cid}/movies")).json().get("items", [])
        titles = [m["title"] for m in movies]
        assert "Coherence" in titles, (
            f"the add did not complete with the metadata read failing — got {titles}"
        )
        added = next(m for m in movies if m["title"] == "Coherence")
        assert not (added.get("ownedMedia") or []), (
            f"recorded media formats {added.get('ownedMedia')} that were never offered"
        )
        print(f"\n@@ T100 step 9: added={added['title']!r} owned={added.get('owned')} "
              f"ownedMedia={added.get('ownedMedia')} — question skipped, nothing guessed")
    finally:
        async with httpx.AsyncClient(base_url="http://localhost:3001",
                                     headers={"Authorization": f"Bearer {tok}"}, timeout=20) as c:
            await c.delete(f"{_API}/collections/{cid}")
