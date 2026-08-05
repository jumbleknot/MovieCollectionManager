"""FR-039 against the LIVE stack — the two cases a unit turn cannot reach (047 T110).

Everything here is real: real movie-mcp, real spreadsheet-mcp, real mc-service writes, and a real
Keycloak RFC 8693 downscoped token per call. The ONLY thing injected is a single transport fault,
via the `call` seam `RuntimeNodeConfig` already exposes — so the failure travels the whole
production path (invoke_tool → the read closure → ToolReadError → the node guard).

Why these two are here rather than in `tests/unit/test_failed_reads.py`: both were attempted as
unit tests first and neither could fail for the right reason, because the turn ended before the
read happened.

  * The IMPORT dedup read runs at APPLY time — after upload → parse → propose → approve. A single
    unit turn stops at the interrupt, so the read is never reached. This is the case FR-018 rests
    on: dedup compares against a read of what is already in the collection, so a failed read makes
    existing movies look absent and re-import creates the duplicates FR-018 forbids.

  * The SEARCH own-data read is only meaningful once the node has a collection to search, which
    needs a seeded collection and a resolved scope.

Note import's `list_movies` carries `skip_rate_limit=True` (040 US2 FR-015), so a constrained
tool-call budget cannot reach it — the fault has to be injected at the transport.
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
from langgraph.types import Command

from src.graph import build_graph
from src.runtime_nodes import RuntimeNodeConfig, build_runtime_nodes
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.mcp_tools import McpCallResult, call_mcp_tool, list_mcp_tools
from src.tools.token_exchange import reexchange_for_mc_service

MOVIE_MCP_URL = os.environ.get("MOVIE_MCP_URL", "http://127.0.0.1:8766/mcp")
WEB_API_MCP_URL = os.environ.get("WEB_API_MCP_URL", "http://127.0.0.1:8765/mcp")
SPREADSHEET_MCP_URL = os.environ.get("SPREADSHEET_MCP_URL", "http://127.0.0.1:8767/mcp")
MC_SERVICE_URL = os.environ.get("MC_SERVICE_URL", "http://localhost:3001")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")


def _sub(jwt: str) -> str:
    payload = jwt.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return str(json.loads(base64.urlsafe_b64decode(payload))["sub"])


async def _require_mcp(*urls: str) -> None:
    for url in urls:
        try:
            await list_mcp_tools(url)
        except Exception as exc:  # noqa: BLE001
            pytest.skip(f"MCP server not reachable at {url}: {exc}")


class _FaultyTransport:
    """The real transport, with one tool failed from its nth call onward."""

    def __init__(self, fail_tool: str, *, fail_from: int = 1) -> None:
        self.fail_tool = fail_tool
        self.fail_from = fail_from
        self.seen: dict[str, int] = {}

    async def __call__(
        self, url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        self.seen[tool_name] = self.seen.get(tool_name, 0) + 1
        if tool_name == self.fail_tool and self.seen[tool_name] >= self.fail_from:
            return McpCallResult(is_error=True, data=None, text="mc-service-status:503 upstream")
        return await call_mcp_tool(url, tool_name, arguments, token)

    def reached(self) -> bool:
        return self.seen.get(self.fail_tool, 0) >= self.fail_from


def _cfg(reexchange_env: dict[str, str], call: Any) -> RuntimeNodeConfig:
    async def authorize(_user: str, _aud: str) -> bool:
        return True  # OPA gated off (not deployed) — allow

    async def exchange(subject_token: str) -> Any:
        return await reexchange_for_mc_service(subject_token, env=reexchange_env)

    return RuntimeNodeConfig(
        web_api_mcp_url=WEB_API_MCP_URL,
        movie_mcp_url=MOVIE_MCP_URL,
        spreadsheet_mcp_url=SPREADSHEET_MCP_URL,
        limiter=AgentToolRateLimiter(max_calls=500, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call,
    )


def _graph(cfg: RuntimeNodeConfig, intent: str) -> Any:
    return build_graph(
        classifier=lambda _m: intent, checkpointer=MemorySaver(), **build_runtime_nodes(cfg)
    )


async def _downscoped(subject_token: str, reexchange_env: dict[str, str]) -> str:
    return (await reexchange_for_mc_service(subject_token, env=reexchange_env)).token


def _mc(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=MC_SERVICE_URL, headers={"Authorization": f"Bearer {token}"}, timeout=20
    )


async def _seed_collection(token: str, name: str) -> str:
    async with _mc(token) as client:
        res = await client.post("/api/v1/collections", json={"name": name})
        res.raise_for_status()
        return str(res.json()["collectionId"])


async def _titles(token: str, collection_id: str) -> list[str]:
    async with _mc(token) as client:
        res = await client.get(f"/api/v1/collections/{collection_id}/movies", params={"limit": 100})
        res.raise_for_status()
        return [str(m["title"]) for m in res.json().get("items", [])]


async def _delete_collection(token: str, collection_id: str) -> None:
    async with _mc(token) as client:
        await client.delete(f"/api/v1/collections/{collection_id}")


async def _seed_upload(handle: str, data: bytes) -> None:
    import redis.asyncio as redis

    client = redis.from_url(REDIS_URL)
    try:
        await client.set(f"import:file:{handle}", data, ex=900)
    finally:
        await client.aclose()


def _csv() -> bytes:
    return b"Title,Year,Video Type\nZorgon,1999,Movie\nPrimer,2004,Movie\n"


def _config(thread: str, subject_token: str, handle: str, filename: str) -> dict[str, Any]:
    return {
        "configurable": {
            "thread_id": thread,
            "subject_token": subject_token,
            "user_id": _sub(subject_token),
            "file_handle": handle,
            "filename": filename,
        }
    }


def _text(result: dict[str, Any]) -> str:
    msgs = result.get("messages") or []
    return str(getattr(msgs[-1], "content", "")) if msgs else ""


# ── T110 case 1: import must not dedup against a read that failed (FR-018 rests on this) ─────────


async def test_reimport_with_an_unreadable_collection_creates_no_duplicates(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_mcp(MOVIE_MCP_URL, SPREADSHEET_MCP_URL)
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t110-imp-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(token, name)
    try:
        # First import, everything healthy → the two rows land.
        healthy = _graph(_cfg(reexchange_env, call_mcp_tool), "import")
        handle = uuid.uuid4().hex
        await _seed_upload(handle, _csv())
        config = _config(f"{name}-r1", subject_token, handle, f"{name}.csv")
        paused = await healthy.ainvoke(
            {"messages": [("user", f"import my movies into {name}")]}, config
        )
        if "__interrupt__" in paused:
            await healthy.ainvoke(Command(resume={"decision": "approved"}), config)
        assert sorted(await _titles(token, collection_id)) == ["Primer", "Zorgon"]

        # Re-import the SAME file, but the read of what is already there fails. Before FR-039 that
        # read returned [] / a truncated list, both movies looked absent, and the re-import
        # duplicated them — exactly what FR-018 forbids.
        faulty = _FaultyTransport("list_movies")
        broken = _graph(_cfg(reexchange_env, faulty), "import")
        handle2 = uuid.uuid4().hex
        await _seed_upload(handle2, _csv())
        config2 = _config(f"{name}-r2", subject_token, handle2, f"{name}.csv")
        again = await broken.ainvoke(
            {"messages": [("user", f"import my movies into {name}")]}, config2
        )
        if "__interrupt__" in again:
            again = await broken.ainvoke(Command(resume={"decision": "approved"}), config2)

        assert faulty.reached(), (
            "vacuous test: the import never read the target collection, so the dedup path was "
            f"not exercised (tools seen: {faulty.seen})"
        )
        # THE OBSERVABLE DIFFERENCE IS THE REPLY, NOT THE STORED TITLES. Verified by reverting
        # the closure to its old collapse and re-running: the titles are identical either way,
        # because mc-service's (title, year) uniqueness rejects the duplicate writes downstream.
        # What the old code did was proceed on a read it never got — building the preview from an
        # empty "what's already there", so the member approved "2 will be added" and was then told
        # "0 imported, 2 already up to date". An approval given on a description of the change
        # that is not true.
        reply = _text(again)
        assert "already up to date" not in reply, (
            "proceeded to a completion report built on a read that failed: " + repr(reply)
        )
        assert "import" in reply.lower() and (
            "failed" in reply.lower() or "couldn't" in reply.lower()
        ), f"a failed dedup read must say so rather than report a result: {reply!r}"
        assert sorted(await _titles(token, collection_id)) == ["Primer", "Zorgon"], (
            "the collection must be left exactly as it was"
        )
    finally:
        await _delete_collection(token, collection_id)


# ── T110 case 2: search must not turn a failed own-data read into an absence claim ───────────────


async def test_search_with_unreadable_collections_makes_no_absence_claim(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_mcp(MOVIE_MCP_URL, WEB_API_MCP_URL)
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t110-search-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(token, name)
    try:
        faulty = _FaultyTransport("list_collections")
        graph = _graph(_cfg(reexchange_env, faulty), "search")
        final = await graph.ainvoke(
            {"messages": [("user", f"do I have Inception in my {name} collection")]},
            {
                "configurable": {
                    "thread_id": f"{name}-s1",
                    "subject_token": subject_token,
                    "user_id": _sub(subject_token),
                }
            },
        )

        assert faulty.reached(), f"vacuous test: list_collections never ran ({faulty.seen})"
        reply = _text(final).lower()
        assert reply, "a failed read must still answer the member"
        for lie in ("couldn't find", "not in your", "don't have", "no results"):
            assert lie not in reply, (
                f"a failed read of the member's OWN collections became {lie!r} — an absence "
                f"claim from no data: {_text(final)!r}"
            )
    finally:
        await _delete_collection(token, collection_id)
