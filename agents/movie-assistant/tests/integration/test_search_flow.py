"""T069 — US7 unified search workflow LIVE: owned search + disambiguation against real mc-service.

The REAL search node (production factory `build_runtime_nodes`) drives `list_collections` /
`list_movies` reads through the Slice-F2 streamable-HTTP transport to a running movie-mcp → real
mc-service, with a REAL Keycloak RFC 8693 downscoped token per call. Resolution + disambiguation
are PURE CODE (no model seam to stub), so this isolates the resolve/match/render path end-to-end.

Proves: a named-collection single match navigates straight to the movie (FR-030); Bug 2 — several
matches DISAMBIGUATE via `render_selection` (no auto-open); a multi-turn pick (same thread)
resolves to `navigate_to_movie`. Web fallback is exercised only when web-api-mcp is also reachable
(skipped otherwise). Skips cleanly without the live stack.

Run:
  cd mcp-servers/movie-mcp && MC_MCP_PORT=8766 MC_MCP_HOST=127.0.0.1 \
      MC_SERVICE_URL=http://localhost:3001 uv run python -m src.server
  MOVIE_MCP_URL=http://127.0.0.1:8766/mcp \
      pnpm nx test:integration movie-assistant -- -k search_flow
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from typing import Any

import httpx
import pytest
from langgraph.checkpoint.memory import MemorySaver

from src.graph import build_graph
from src.runtime_nodes import RuntimeNodeConfig, build_runtime_nodes
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.mcp_tools import call_mcp_tool, list_mcp_tools
from src.tools.token_exchange import reexchange_for_mc_service

MOVIE_MCP_URL = os.environ.get("MOVIE_MCP_URL", "http://127.0.0.1:8766/mcp")
WEB_API_MCP_URL = os.environ.get("WEB_API_MCP_URL", "http://127.0.0.1:8765/mcp")
MC_SERVICE_URL = os.environ.get("MC_SERVICE_URL", "http://localhost:3001")
_API = "/api/v1"


def _sub(jwt: str) -> str:
    payload = jwt.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return str(json.loads(base64.urlsafe_b64decode(payload))["sub"])


async def _require_movie_mcp() -> None:
    try:
        await list_mcp_tools(MOVIE_MCP_URL)
    except Exception as exc:  # noqa: BLE001 — any connect/transport failure ⇒ skip
        pytest.skip(f"movie-mcp not reachable at {MOVIE_MCP_URL}: {exc}")


async def _web_mcp_reachable() -> bool:
    try:
        await list_mcp_tools(WEB_API_MCP_URL)
        return True
    except Exception:  # noqa: BLE001
        return False


def _movie_body(title: str, year: int) -> dict[str, Any]:
    return {
        "title": title, "year": year, "contentType": "Movie", "language": "English",
        "owned": True, "ripped": False, "childrens": False, "ownedMedia": [], "ripQuality": [],
        "genres": ["Sci-Fi"], "rated": "R", "directors": [], "actors": [], "tags": [],
        "movieSet": None, "originalTitle": None, "releaseDate": None, "outline": None,
        "plot": None, "runtime": None, "externalIds": [],
    }


def _live_cfg(reexchange_env: dict[str, str]) -> RuntimeNodeConfig:
    async def authorize(_user: str, _aud: str) -> bool:
        return True  # OPA gated off (not deployed) — allow

    async def exchange(subject_token: str) -> Any:
        return await reexchange_for_mc_service(subject_token, env=reexchange_env)

    return RuntimeNodeConfig(
        web_api_mcp_url=WEB_API_MCP_URL,
        movie_mcp_url=MOVIE_MCP_URL,
        limiter=AgentToolRateLimiter(max_calls=500, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call_mcp_tool,
    )


def _graph(cfg: RuntimeNodeConfig) -> Any:
    nodes = build_runtime_nodes(cfg)
    return build_graph(classifier=lambda _m: "search", checkpointer=MemorySaver(), **nodes)


def _config(thread: str, subject_token: str) -> dict[str, Any]:
    return {
        "configurable": {
            "thread_id": thread,
            "subject_token": subject_token,
            "user_id": _sub(subject_token),
        }
    }


def _last(final: dict[str, Any]) -> Any:
    return final["messages"][-1]


def _tool_names(message: Any) -> list[str]:
    return [c["name"] for c in (getattr(message, "tool_calls", []) or [])]


def _tool_call(message: Any, name: str) -> dict[str, Any]:
    return next(c for c in (getattr(message, "tool_calls", []) or []) if c["name"] == name)


async def _downscoped(subject_token: str, reexchange_env: dict[str, str]) -> str:
    return (await reexchange_for_mc_service(subject_token, env=reexchange_env)).token


def _mc(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=MC_SERVICE_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=15.0,
    )


async def _seed_collection(token: str, name: str, movies: list[tuple[str, int]]) -> str:
    async with _mc(token) as client:
        resp = await client.post(f"{_API}/collections", json={"name": name})
        resp.raise_for_status()
        collection_id = str(resp.json()["collectionId"])
        for title, year in movies:
            r = await client.post(
                f"{_API}/collections/{collection_id}/movies", json=_movie_body(title, year)
            )
            r.raise_for_status()
        return collection_id


async def _delete_collection(token: str, collection_id: str) -> None:
    async with _mc(token) as client:
        await client.delete(f"{_API}/collections/{collection_id}")


# ── tests ───────────────────────────────────────────────────────────────────────────────────


async def test_search_named_collection_single_match_navigates(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t069-one-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(token, name, [("Coherence", 2013), ("Primer", 2004)])
    try:
        graph = _graph(_live_cfg(reexchange_env))
        final = await graph.ainvoke(
            {"messages": [("user", f"find Coherence in my {name} collection")]},
            _config(f"t069-one-{uuid.uuid4().hex[:8]}", subject_token),
        )
        assert "navigate_to_movie" in _tool_names(_last(final))
        nav = _tool_call(_last(final), "navigate_to_movie")
        assert nav["args"]["collectionId"] == collection_id
    finally:
        await _delete_collection(token, collection_id)


async def test_search_multiple_matches_disambiguate(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t069-many-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(
        token, name, [("Avatar", 2009), ("Avatar: The Way of Water", 2022)]
    )
    try:
        graph = _graph(_live_cfg(reexchange_env))
        # Bug 2: several matches must offer buttons, NOT open the first.
        final = await graph.ainvoke(
            {"messages": [("user", f"show me Avatar in my {name} collection")]},
            _config(f"t069-many-{uuid.uuid4().hex[:8]}", subject_token),
        )
        assert "render_selection" in _tool_names(_last(final))
        assert "navigate_to_movie" not in _tool_names(_last(final))
        sel = _tool_call(_last(final), "render_selection")
        labels = [o["value"] for o in sel["args"]["options"]]
        assert "Avatar (2009)" in labels
    finally:
        await _delete_collection(token, collection_id)


async def test_search_multi_turn_pick_navigates(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t069-pick-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(
        token, name, [("Avatar", 2009), ("Avatar: The Way of Water", 2022)]
    )
    try:
        graph = _graph(_live_cfg(reexchange_env))
        thread = f"t069-pick-{uuid.uuid4().hex[:8]}"
        # turn 1: disambiguation buttons
        await graph.ainvoke(
            {"messages": [("user", f"show me Avatar in my {name} collection")]},
            _config(thread, subject_token),
        )
        # turn 2 (same thread): pick the 2009 one → navigate
        final = await graph.ainvoke(
            {"messages": [("user", "Avatar (2009)")]},
            _config(thread, subject_token),
        )
        assert "navigate_to_movie" in _tool_names(_last(final))
    finally:
        await _delete_collection(token, collection_id)


async def test_search_web_fallback_shows_preview_card(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    if not await _web_mcp_reachable():
        pytest.skip(f"web-api-mcp not reachable at {WEB_API_MCP_URL}")
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t069-web-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(token, name, [("Primer", 2004)])
    try:
        graph = _graph(_live_cfg(reexchange_env))
        thread = f"t069-web-{uuid.uuid4().hex[:8]}"
        # no owned match → control buttons including "search the web"
        await graph.ainvoke(
            {"messages": [("user", f"find Inception in my {name} collection")]},
            _config(thread, subject_token),
        )
        final = await graph.ainvoke(
            {"messages": [("user", "search the web")]},
            _config(thread, subject_token),
        )
        names = _tool_names(_last(final))
        # either a single preview card, or a list of web result buttons to pick from
        assert "render_movie_card" in names or "render_selection" in names
    finally:
        await _delete_collection(token, collection_id)
