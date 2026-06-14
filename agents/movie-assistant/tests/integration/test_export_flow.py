"""T048 — US3 export flow LIVE: export a seeded collection → a valid `.xlsx`, and a round-trip
export→import preserves the multi-value sets (order-independent), no duplicates.

The REAL `export_collection` node (production factory) reads the collection via a running
**movie-mcp** → real mc-service (REAL Keycloak downscoped token) and builds the workbook via a
running **spreadsheet-mcp** (bytes land in the transient Redis `export:file:` store). The round
trip then feeds those exact bytes back through the `import_collection` node. Export is read-only
(no approval gate); import is HITL. Skips cleanly without the live stack.

Run (two local MCP servers + the live backend on :3001/:6379/:8099):
  cd mcp-servers/movie-mcp && MC_MCP_PORT=8766 MC_MCP_HOST=127.0.0.1 \
      MC_SERVICE_URL=http://localhost:3001 uv run python -m src.server &
  cd mcp-servers/spreadsheet-mcp && SPREADSHEET_MCP_PORT=8767 SPREADSHEET_MCP_HOST=127.0.0.1 \
      REDIS_URL=redis://localhost:6379 uv run python -m src.server &
  MOVIE_MCP_URL=http://127.0.0.1:8766/mcp SPREADSHEET_MCP_URL=http://127.0.0.1:8767/mcp \
      pnpm nx test:integration movie-assistant -- -k export_flow

Covers: US3-AC1/2/3/4, SC-004, SC-008.
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from typing import Any

import httpx
import pytest
import redis.asyncio as redis
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src.graph import build_graph
from src.runtime_nodes import RuntimeNodeConfig, build_runtime_nodes
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.mcp_tools import call_mcp_tool, list_mcp_tools
from src.tools.token_exchange import reexchange_for_mc_service

MOVIE_MCP_URL = os.environ.get("MOVIE_MCP_URL", "http://127.0.0.1:8766/mcp")
SPREADSHEET_MCP_URL = os.environ.get("SPREADSHEET_MCP_URL", "http://127.0.0.1:8767/mcp")
MC_SERVICE_URL = os.environ.get("MC_SERVICE_URL", "http://localhost:3001")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
_API = "/api/v1"
_XLSX_MAGIC = b"PK\x03\x04"  # .xlsx is a zip archive


def _sub(jwt: str) -> str:
    payload = jwt.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return str(json.loads(base64.urlsafe_b64decode(payload))["sub"])


async def _require_mcp() -> None:
    for url in (MOVIE_MCP_URL, SPREADSHEET_MCP_URL):
        try:
            await list_mcp_tools(url)
        except Exception as exc:  # noqa: BLE001 — any connect/transport failure ⇒ skip
            pytest.skip(f"MCP not reachable at {url}: {exc}")


def _live_cfg(reexchange_env: dict[str, str]) -> RuntimeNodeConfig:
    async def authorize(_user: str, _aud: str) -> bool:
        return True

    async def exchange(subject_token: str) -> Any:
        return await reexchange_for_mc_service(subject_token, env=reexchange_env)

    return RuntimeNodeConfig(
        web_api_mcp_url="http://unused/mcp",
        movie_mcp_url=MOVIE_MCP_URL,
        spreadsheet_mcp_url=SPREADSHEET_MCP_URL,
        limiter=AgentToolRateLimiter(max_calls=500, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call_mcp_tool,
    )


def _graph(cfg: RuntimeNodeConfig, intent: str) -> Any:
    nodes = build_runtime_nodes(cfg)
    return build_graph(classifier=lambda _m: intent, checkpointer=MemorySaver(), **nodes)


def _export_handle(result: dict[str, Any]) -> str | None:
    for msg in result.get("messages", []) or []:
        for call in getattr(msg, "tool_calls", None) or []:
            if call.get("name") == "download_export":
                return str(call.get("args", {}).get("handle") or "") or None
    return None


# ── transient store + mc-service helpers ─────────────────────────────────────────────────────


async def _read_export(handle: str) -> bytes | None:
    client = redis.from_url(REDIS_URL, decode_responses=False)
    try:
        return await client.get("export:file:" + handle)
    finally:
        await client.aclose()


async def _seed_import(handle: str, data: bytes) -> None:
    client = redis.from_url(REDIS_URL, decode_responses=False)
    try:
        await client.set("import:file:" + handle, data, ex=300)
    finally:
        await client.aclose()


async def _downscoped(subject_token: str, reexchange_env: dict[str, str]) -> str:
    return (await reexchange_for_mc_service(subject_token, env=reexchange_env)).token


def _mc(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=MC_SERVICE_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=15.0,
    )


def _movie_body(title: str, genres: list[str], tags: list[str]) -> dict[str, Any]:
    return {
        "title": title, "year": 1999, "contentType": "Movie", "language": "English",
        "owned": True, "ripped": False, "childrens": False, "ownedMedia": [], "ripQuality": [],
        "genres": genres, "rated": "R", "directors": [], "actors": [], "tags": tags,
        "movieSet": None, "originalTitle": None, "releaseDate": None, "outline": None,
        "plot": None, "runtime": None, "externalIds": [],
    }


async def _seed_collection(token: str, name: str, movies: list[dict[str, Any]]) -> str:
    async with _mc(token) as client:
        resp = await client.post(f"{_API}/collections", json={"name": name})
        resp.raise_for_status()
        collection_id = str(resp.json()["collectionId"])
        for body in movies:
            r = await client.post(f"{_API}/collections/{collection_id}/movies", json=body)
            r.raise_for_status()
        return collection_id


async def _movies(token: str, collection_id: str) -> list[dict[str, Any]]:
    async with _mc(token) as client:
        resp = await client.get(f"{_API}/collections/{collection_id}/movies")
        resp.raise_for_status()
        body = resp.json()
        return list(body.get("items", body) if isinstance(body, dict) else body)


async def _multivalues(token: str, collection_id: str) -> dict[str, dict[str, set[str]]]:
    """{title: {"genres": {...}, "tags": {...}}} — order-independent multi-value sets."""
    return {
        str(m["title"]): {"genres": set(m.get("genres") or []), "tags": set(m.get("tags") or [])}
        for m in await _movies(token, collection_id)
    }


async def _delete_collection(token: str, collection_id: str) -> None:
    async with _mc(token) as client:
        await client.delete(f"{_API}/collections/{collection_id}")


async def _delete_movie(token: str, collection_id: str, movie_id: str) -> None:
    async with _mc(token) as client:
        await client.delete(f"{_API}/collections/{collection_id}/movies/{movie_id}")


# ── tests ───────────────────────────────────────────────────────────────────────────────────


async def test_export_round_trips_multi_value_sets(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    user_id = _sub(subject_token)
    name = f"rt-{uuid.uuid4().hex[:8]}"  # short ⇒ a clean ≤31-char sheet name
    collection_id = await _seed_collection(
        token, name,
        [
            _movie_body("Zorgon", ["Sci-Fi", "Action"], ["cult", "favourite"]),
            _movie_body("Quaffle", ["Comedy"], []),
        ],
    )
    try:
        original = await _multivalues(token, collection_id)

        # Export (read-only → no approval gate). Selected via export_collection_ids.
        export_cfg = {
            "configurable": {
                "thread_id": f"{name}-exp", "subject_token": subject_token,
                "user_id": user_id, "export_collection_ids": [collection_id],
            }
        }
        exported = await _graph(_live_cfg(reexchange_env), "export").ainvoke(
            {"messages": [("user", "export my collection to a spreadsheet")]}, export_cfg
        )
        handle = _export_handle(exported)
        assert handle, "export should emit a download_export handle"
        blob = await _read_export(handle)
        assert blob and blob[:4] == _XLSX_MAGIC, "a valid .xlsx workbook should be stored (SC-008)"

        # Empty the collection, then import the exported workbook back into it.
        for m in await _movies(token, collection_id):
            await _delete_movie(token, collection_id, str(m["movieId"]))
        assert await _multivalues(token, collection_id) == {}

        import_handle = uuid.uuid4().hex
        await _seed_import(import_handle, blob)
        import_cfg = {
            "configurable": {
                "thread_id": f"{name}-imp", "subject_token": subject_token, "user_id": user_id,
                "file_handle": import_handle, "filename": f"{name}.xlsx",
            }
        }
        graph = _graph(_live_cfg(reexchange_env), "import")
        paused = await graph.ainvoke(
            {"messages": [("user", "import my movies from this spreadsheet")]}, import_cfg
        )
        assert "__interrupt__" in paused
        await graph.ainvoke(Command(resume={"decision": "approved"}), import_cfg)

        # Round-trip fidelity: same titles, same multi-value sets (order-independent), no dupes.
        assert await _multivalues(token, collection_id) == original
    finally:
        await _delete_collection(token, collection_id)
