"""T071g — US4 query flow LIVE: count / list / find against a real movie-mcp → mc-service.

The REAL query node (production factory `build_runtime_nodes`) drives count/list/find reads
through the Slice-F2 streamable-HTTP transport to a running movie-mcp → real mc-service, with a
REAL Keycloak RFC 8693 downscoped token per call. The model EXTRACTION is stubbed (deterministic
`{collection_ref, movie_title, filter}` via the `query_extract` seam) so this isolates the
resolve/count/render path; the extraction decision is covered by the golden gate (T071f). The
subject token reaches the node via `config["configurable"]` (the production wiring).

Proves: count answers the real server-side total (T071b endpoint), list renders the collection
summary, a find-hit renders the movie card for a movie that IS held, and a find-miss says the
title isn't in THAT collection (≠ the external no-match copy — FR-024). Read-only — no interrupt,
no writes. Skips cleanly without the live stack.

Run:
  cd mcp-servers/movie-mcp && MC_MCP_PORT=8766 MC_MCP_HOST=127.0.0.1 \
      MC_SERVICE_URL=http://localhost:3001 uv run python -m src.server
  MOVIE_MCP_URL=http://127.0.0.1:8766/mcp \
      pnpm nx test:integration movie-assistant -- -k query_flow
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from collections.abc import Sequence
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


def _movie_body(title: str) -> dict[str, Any]:
    return {
        "title": title, "year": 1999, "contentType": "Movie", "language": "English",
        "owned": True, "ripped": False, "childrens": False, "ownedMedia": [], "ripQuality": [],
        "genres": ["Sci-Fi"], "rated": "R", "directors": [], "actors": [], "tags": [],
        "movieSet": None, "originalTitle": None, "releaseDate": None, "outline": None,
        "plot": None, "runtime": None, "externalIds": [],
    }


def _extract(collection_ref: str | None, movie_title: str | None = None, **filt: Any) -> Any:
    def query_extract(_messages: Sequence[Any]) -> dict[str, Any]:
        return {"collection_ref": collection_ref, "movie_title": movie_title, "filter": dict(filt)}

    return query_extract


def _live_cfg(reexchange_env: dict[str, str], query_extract: Any) -> RuntimeNodeConfig:
    async def authorize(_user: str, _aud: str) -> bool:
        return True  # OPA gated off (not deployed) — allow

    async def exchange(subject_token: str) -> Any:
        return await reexchange_for_mc_service(subject_token, env=reexchange_env)

    return RuntimeNodeConfig(
        web_api_mcp_url="http://unused/mcp",  # query doesn't touch web-api-mcp
        movie_mcp_url=MOVIE_MCP_URL,
        limiter=AgentToolRateLimiter(max_calls=500, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call_mcp_tool,
        query_extract=query_extract,
    )


def _graph(cfg: RuntimeNodeConfig) -> Any:
    nodes = build_runtime_nodes(cfg)
    return build_graph(classifier=lambda _m: "query", checkpointer=MemorySaver(), **nodes)


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


# ── mc-service helpers ───────────────────────────────────────────────────────────────────────


async def _downscoped(subject_token: str, reexchange_env: dict[str, str]) -> str:
    return (await reexchange_for_mc_service(subject_token, env=reexchange_env)).token


def _mc(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=MC_SERVICE_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=15.0,
    )


async def _seed_collection(token: str, name: str, titles: list[str]) -> str:
    async with _mc(token) as client:
        resp = await client.post(f"{_API}/collections", json={"name": name})
        resp.raise_for_status()
        collection_id = str(resp.json()["collectionId"])
        for title in titles:
            r = await client.post(
                f"{_API}/collections/{collection_id}/movies", json=_movie_body(title)
            )
            r.raise_for_status()
        return collection_id


async def _delete_collection(token: str, collection_id: str) -> None:
    async with _mc(token) as client:
        await client.delete(f"{_API}/collections/{collection_id}")


# ── tests ───────────────────────────────────────────────────────────────────────────────────


async def test_query_count_answers_real_total(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t071-cnt-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(token, name, ["Alpha", "Beta", "Gamma"])
    try:
        graph = _graph(_live_cfg(reexchange_env, _extract(name)))
        final = await graph.ainvoke(
            {"messages": [("user", f"how many movies are in my {name} collection")]},
            _config(f"t071-cnt-{uuid.uuid4().hex[:8]}", subject_token),
        )
        assert "3 movie" in _last(final).content  # the real server-side count (T071b)
        assert name in _last(final).content
    finally:
        await _delete_collection(token, collection_id)


async def test_query_list_renders_summary_and_titles(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t071-lst-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(token, name, ["Alpha", "Beta"])
    try:
        graph = _graph(_live_cfg(reexchange_env, _extract(name)))
        final = await graph.ainvoke(
            {"messages": [("user", f"what's in my {name} collection")]},
            _config(f"t071-lst-{uuid.uuid4().hex[:8]}", subject_token),
        )
        assert "render_collection_summary" in _tool_names(_last(final))
        assert "Alpha" in _last(final).content  # the first page of titles is listed
    finally:
        await _delete_collection(token, collection_id)


async def test_query_find_hit_renders_movie_card(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t071-hit-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(token, name, ["Alpha", "Beta"])
    try:
        graph = _graph(_live_cfg(reexchange_env, _extract(name, movie_title="Alpha")))
        final = await graph.ainvoke(
            {"messages": [("user", f"do I have Alpha in my {name} collection")]},
            _config(f"t071-hit-{uuid.uuid4().hex[:8]}", subject_token),
        )
        assert "render_movie_card" in _tool_names(_last(final))
        assert "is in your" in _last(final).content
    finally:
        await _delete_collection(token, collection_id)


async def test_query_find_miss_says_not_in_collection(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t071-miss-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(token, name, ["Alpha"])
    try:
        graph = _graph(_live_cfg(reexchange_env, _extract(name, movie_title="Inception")))
        final = await graph.ainvoke(
            {"messages": [("user", f"do I have Inception in my {name} collection")]},
            _config(f"t071-miss-{uuid.uuid4().hex[:8]}", subject_token),
        )
        # About THEIR collection, not an external no-match (FR-024).
        assert "isn't in your" in _last(final).content
        assert name in _last(final).content
        assert not _tool_names(_last(final))  # no card on a miss
    finally:
        await _delete_collection(token, collection_id)
