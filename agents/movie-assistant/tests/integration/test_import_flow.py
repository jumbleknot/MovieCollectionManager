"""T038 — US2 import flow LIVE: upload CSV → preview behind the gate → approve creates exactly the
rows (multi-values split, titles normalized); re-run is idempotent; reject writes nothing.

The REAL `import_collection` node + approval_gate (production factory `build_runtime_nodes`) drive
the parse through the Slice-F2 streamable-HTTP transport to a running **spreadsheet-mcp** (by a
transient Redis upload handle) + a running **movie-mcp** → real mc-service, with a REAL Keycloak
RFC 8693 downscoped token per write. No model is involved (the supervisor `import` decision is the
golden surface, T024); column mapping / article normalization / dedup are pure code. Skips cleanly
without the live stack.

Run (two local MCP servers + the live backend on :3001/:6379/:8099):
  cd mcp-servers/movie-mcp && MC_MCP_PORT=8766 MC_MCP_HOST=127.0.0.1 \
      MC_SERVICE_URL=http://localhost:3001 uv run python -m src.server &
  cd mcp-servers/spreadsheet-mcp && SPREADSHEET_MCP_PORT=8767 SPREADSHEET_MCP_HOST=127.0.0.1 \
      REDIS_URL=redis://localhost:6379 uv run python -m src.server &
  MOVIE_MCP_URL=http://127.0.0.1:8766/mcp SPREADSHEET_MCP_URL=http://127.0.0.1:8767/mcp \
      pnpm nx test:integration movie-assistant -- -k import_flow

Covers: US2-AC1/5/6/7, SC-002, SC-005, SC-009/FR-020.
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from pathlib import Path
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
_IMPORT_PREFIX = "import:file:"


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


async def _seed_upload(handle: str, data: bytes) -> None:
    """Stash CSV bytes under a transient import handle, exactly as the BFF /import-upload would."""
    client = redis.from_url(REDIS_URL, decode_responses=False)
    try:
        await client.set(_IMPORT_PREFIX + handle, data, ex=300)
    finally:
        await client.aclose()


def _live_cfg(reexchange_env: dict[str, str]) -> RuntimeNodeConfig:
    async def authorize(_user: str, _aud: str) -> bool:
        return True  # OPA gated off (not deployed) — allow

    async def exchange(subject_token: str) -> Any:
        return await reexchange_for_mc_service(subject_token, env=reexchange_env)

    return RuntimeNodeConfig(
        web_api_mcp_url="http://unused/mcp",  # import doesn't touch web-api-mcp
        movie_mcp_url=MOVIE_MCP_URL,
        spreadsheet_mcp_url=SPREADSHEET_MCP_URL,
        limiter=AgentToolRateLimiter(max_calls=500, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call_mcp_tool,
    )


def _graph(cfg: RuntimeNodeConfig) -> Any:
    nodes = build_runtime_nodes(cfg)
    return build_graph(classifier=lambda _m: "import", checkpointer=MemorySaver(), **nodes)


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


# ── mc-service helpers ───────────────────────────────────────────────────────────────────────


async def _downscoped(subject_token: str, reexchange_env: dict[str, str]) -> str:
    return (await reexchange_for_mc_service(subject_token, env=reexchange_env)).token


def _mc(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=MC_SERVICE_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=15.0,
    )


async def _seed_collection(token: str, name: str) -> str:
    async with _mc(token) as client:
        resp = await client.post(f"{_API}/collections", json={"name": name})
        resp.raise_for_status()
        return str(resp.json()["collectionId"])


async def _movies(token: str, collection_id: str) -> list[dict[str, Any]]:
    async with _mc(token) as client:
        resp = await client.get(f"{_API}/collections/{collection_id}/movies")
        resp.raise_for_status()
        body = resp.json()
        items = body.get("items", body) if isinstance(body, dict) else body
        return list(items)


async def _movie_titles(token: str, collection_id: str) -> set[str]:
    return {str(m["title"]) for m in (await _movies(token, collection_id))}


async def _delete_collection(token: str, collection_id: str) -> None:
    async with _mc(token) as client:
        await client.delete(f"{_API}/collections/{collection_id}")


# A CSV whose tab name (filename stem) == the collection name ⇒ no disambiguation (the US4 path is
# the agent E2E, T056). "The Matrix" comes in trailing-article form to exercise normalization; the
# Genres column is multi-valued (pipe) to exercise the splitter (US2-AC5).
def _csv() -> bytes:
    return (
        b"Title,Year,Video Type,Genres\n"
        b"Zorgon,1999,Movie,Sci-Fi|Action\n"
        b'"Matrix, The",1999,Movie,Sci-Fi\n'  # comma in the value ⇒ must be CSV-quoted
    )


# ── tests ───────────────────────────────────────────────────────────────────────────────────


async def test_import_creates_on_approval_then_idempotent(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t038-imp-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(token, name)
    try:
        graph = _graph(_live_cfg(reexchange_env))

        # Turn 1: import → preview behind the gate, nothing written (SC-009/FR-020).
        handle = uuid.uuid4().hex
        await _seed_upload(handle, _csv())
        config = _config(f"{name}-r1", subject_token, handle, f"{name}.csv")
        paused = await graph.ainvoke(
            {"messages": [("user", "import my movies from this spreadsheet")]}, config
        )
        assert "__interrupt__" in paused
        assert await _movie_titles(token, collection_id) == set()

        # Approve → exactly the two rows, the trailing article normalized, multi-values split.
        final = await graph.ainvoke(Command(resume={"decision": "approved"}), config)
        assert final.get("status") == "completed"
        assert await _movie_titles(token, collection_id) == {"Zorgon", "The Matrix"}
        zorgon = next(m for m in await _movies(token, collection_id) if m["title"] == "Zorgon")
        assert set(zorgon.get("genres") or []) == {"Sci-Fi", "Action"}  # US2-AC5 split

        # Re-run the identical import (fresh single-use handle) → idempotent: still exactly the two
        # movies, none duplicated (SC-005).
        handle2 = uuid.uuid4().hex
        await _seed_upload(handle2, _csv())
        config2 = _config(f"{name}-r2", subject_token, handle2, f"{name}.csv")
        again = await graph.ainvoke(
            {"messages": [("user", "import my movies from this spreadsheet")]}, config2
        )
        if "__interrupt__" in again:
            await graph.ainvoke(Command(resume={"decision": "approved"}), config2)
        assert await _movie_titles(token, collection_id) == {"Zorgon", "The Matrix"}
    finally:
        await _delete_collection(token, collection_id)


_SAMPLE_XLSX = Path(__file__).resolve().parents[4] / "docs" / "test-data" / "sample-movies.xlsx"


async def _run_full_import(
    graph: Any, *, name: str, subject_token: str, data: bytes, tag: str
) -> Any:
    """Drive one full import of `data` into the collection `name` (disambiguation → approve).

    The sample's data tab is "Sample"; a uniquely-named target collection does NOT match it, so
    turn 1 asks which collection (no write), the pick turn (no file_handle — single-use) resolves
    it and pauses at the preview, and the approved resume applies. Returns the ApplyResult.
    """
    handle = uuid.uuid4().hex
    await _seed_upload(handle, data)
    with_handle = _config(f"{name}-{tag}", subject_token, handle, f"{name}.xlsx")
    no_handle = {
        "configurable": {
            "thread_id": f"{name}-{tag}",
            "subject_token": subject_token,
            "user_id": _sub(subject_token),
        }
    }
    turn1 = await graph.ainvoke(
        {"messages": [("user", "import my movies from this spreadsheet")]}, with_handle
    )
    paused = turn1
    if "__interrupt__" not in turn1:
        # tab "Sample" didn't match the unique collection name → resolve the pick (no handle).
        paused = await graph.ainvoke({"messages": [("user", name)]}, no_handle)
    assert "__interrupt__" in paused, f"{tag}: expected the import preview interrupt"
    final = await graph.ainvoke(Command(resume={"decision": "approved"}), no_handle)
    return final.get("apply_result")


async def test_reimport_real_sample_updates_without_failures(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    """REPRODUCTION: re-importing the real ~200-row sample into a collection that already holds it
    must apply/UPDATE every VALID row with no SPURIOUS failures (the user saw "165 imported, 35
    could not" — good rows failing en masse). The sample deliberately includes three rows titled
    "Expected Import Failure N" (e.g. owned=false WITH physical media → mc-service 400; a
    non-numeric Year) that prove a bad row is isolated and reported WITHOUT sinking the whole
    import (FR-017). So the assertion is "no UNEXPECTED failures", not "zero failures"."""
    await _require_mcp()
    if not _SAMPLE_XLSX.exists():
        pytest.skip(f"sample fixture missing: {_SAMPLE_XLSX}")
    name = f"t014reimport{uuid.uuid4().hex[:8]}"  # unique → won't match the "Sample" tab

    async def fresh_token() -> str:
        # The downscoped mc-service token is short-lived (~60s); re-acquire one per slow read so
        # the TEST harness never 401s — that would mask the APPLY result we're measuring.
        return await _downscoped(subject_token, reexchange_env)

    async def run(tag: str) -> Any:
        return await _run_full_import(
            graph, name=name, subject_token=subject_token, data=data, tag=tag
        )

    def unexpected(result: Any) -> list[dict[str, Any]]:
        # The sample's intentional bad rows are titled "Expected Import Failure N" — any OTHER
        # failure is the real regression this reproduction guards against.
        return [
            f
            for f in (result.failures or [])
            if not str(f.get("title", "")).startswith("Expected Import Failure")
        ]

    collection_id = await _seed_collection(await fresh_token(), name)
    data = _SAMPLE_XLSX.read_bytes()
    try:
        graph = _graph(_live_cfg(reexchange_env))

        first = await run("r1")
        assert first is not None, "import #1 produced no result"
        assert first.applied_item_ids, "import #1 applied nothing"  # the valid rows went in
        assert not unexpected(first), (
            f"import #1 had UNEXPECTED failures (beyond the sample's intentional bad rows): "
            f"{unexpected(first)}"
        )

        second = await run("r2")
        assert second is not None
        # Re-import must be all updates with no SPURIOUS failures (the "35 could not" regression).
        assert not unexpected(second), (
            f"re-import had UNEXPECTED failures: {unexpected(second)}"
        )
    finally:
        await _delete_collection(await fresh_token(), collection_id)


async def test_import_report_lists_skipped_and_failed_with_reasons(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    """Enhancement 3 (live): a row missing a required field is skipped (plan-time) and a row
    mc-service rejects (Year out of range → 422) fails — the report carries BOTH with reasons,
    and the field-level mc-service `detail` propagates end-to-end through movie-mcp + the gateway.
    """
    await _require_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    # CSV tab == filename stem == collection name ⇒ auto-match
    name = f"t014report{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(token, name)
    csv = (
        b"Title,Year,Video Type\n"
        b"Good Movie,1999,Movie\n"
        b"Missing Year,,Movie\n"  # plan-time skip: missing required Year
        b"Bad Year,5,Movie\n"  # 5 is a valid int but out of range → mc-service 422
    )
    try:
        graph = _graph(_live_cfg(reexchange_env))
        handle = uuid.uuid4().hex
        await _seed_upload(handle, csv)
        config = _config(f"{name}-r1", subject_token, handle, f"{name}.csv")
        paused = await graph.ainvoke(
            {"messages": [("user", "import my movies from this spreadsheet")]}, config
        )
        assert "__interrupt__" in paused
        final = await graph.ainvoke(Command(resume={"decision": "approved"}), config)

        result = final.get("apply_result")
        assert result is not None
        assert len(result.applied_item_ids) == 1  # only "Good Movie" lands
        # The failed row carries mc-service's FIELD-LEVEL reason (propagated end-to-end through
        # movie-mcp + the gateway), not the generic message (ValidationError → 400 or 422).
        assert any(
            "4-digit" in f["reason"] and "mc-service" in f["reason"] for f in result.failures
        ), result.failures

        # The completion emits the report card carrying the plan-time skip + the apply failure.
        report_calls = [
            c
            for c in (final["messages"][-1].tool_calls or [])
            if c["name"] == "render_import_report"
        ]
        assert report_calls, "expected a render_import_report tool call"
        report = report_calls[0]["args"]
        assert any("Missing Year" in s["title"] for s in report["skipped"])
        assert any("Bad Year" in f["title"] for f in report["failed"])
    finally:
        await _delete_collection(token, collection_id)


async def test_import_reject_writes_nothing(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    """T033a (real-MCP): cancelling at the preview leaves the collection unchanged (FR-020)."""
    await _require_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t038-rej-{uuid.uuid4().hex[:8]}"
    collection_id = await _seed_collection(token, name)
    try:
        graph = _graph(_live_cfg(reexchange_env))
        handle = uuid.uuid4().hex
        await _seed_upload(handle, _csv())
        config = _config(f"{name}-rej", subject_token, handle, f"{name}.csv")
        await graph.ainvoke(
            {"messages": [("user", "import my movies from this spreadsheet")]}, config
        )
        await graph.ainvoke(Command(resume={"decision": "rejected"}), config)
        assert await _movie_titles(token, collection_id) == set()  # nothing written
    finally:
        await _delete_collection(token, collection_id)
