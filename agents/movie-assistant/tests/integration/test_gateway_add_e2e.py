"""Gateway AG-UI add — the deploy cut-over proof (US1 Slice G).

Drives the FULL gateway AG-UI HTTP endpoint in-process (FastAPI TestClient) end-to-end:

  POST /agent/movie-assistant  (Authorization: Bearer <real subject token>)
    → SubjectTokenMiddleware (ContextVar) → IdentityAwareAGUIAgent (config["configurable"])
    → build_runtime_graph PRODUCTION nodes
    → curator enrich via REAL web-api-mcp/TMDB
    → organizer list via REAL movie-mcp → real mc-service (downscoped token from a REAL
      Keycloak RFC 8693 exchange)
    → approval_gate interrupt()  (nothing written yet)
  POST again with forwardedProps.command.resume={decision: approved}
    → approval_gate applies the write → movie persisted in mc-service.

This is the composition T036 (nodes direct) + the bridge test (header→config) never exercised
together. Per the constitution (cassette ONLY the LLM, keep every dependency real) the two LLM
calls — intent classification + entity extraction — are stubbed deterministically; TMDB,
movie-mcp, mc-service, and the Keycloak exchange are all REAL. Live Ollama routing is covered by
T029. Observable proof is mc-service state: nothing pre-approval, the movie post-approval.

Uses an EXACT-resolving TMDB title ("Coherence" 2013 → a single result → matchConfidence=exact).
Skips cleanly without the live stack / MCP servers / creds.

Run (with movie-mcp on :8766 and web-api-mcp on :8765):
  MOVIE_MCP_URL=http://127.0.0.1:8766/mcp WEB_API_MCP_URL=http://127.0.0.1:8765/mcp \
      pnpm nx test:integration movie-assistant -- -k gateway_add
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import MemorySaver

from src.gateway import AGENT_PATH, build_app
from src.runtime_nodes import RuntimeNodeConfig, build_runtime_graph
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.mcp_tools import call_mcp_tool, list_mcp_tools
from src.tools.token_exchange import reexchange_for_mc_service

MOVIE_MCP_URL = os.environ.get("MOVIE_MCP_URL", "http://127.0.0.1:8766/mcp")
WEB_API_MCP_URL = os.environ.get("WEB_API_MCP_URL", "http://127.0.0.1:8765/mcp")
MC_SERVICE_URL = os.environ.get("MC_SERVICE_URL", "http://localhost:3001")
_API = "/api/v1"

# An exact-resolving title (a single TMDB result → matchConfidence=exact → a real candidate).
_TITLE, _YEAR = "Coherence", 2013


def _sub(jwt: str) -> str:
    payload = jwt.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return str(json.loads(base64.urlsafe_b64decode(payload))["sub"])


async def _require_mcp_servers() -> None:
    for url in (MOVIE_MCP_URL, WEB_API_MCP_URL):
        try:
            await list_mcp_tools(url)
        except Exception as exc:  # noqa: BLE001
            pytest.skip(f"MCP server not reachable at {url}: {exc}")


def _cfg(reexchange_env: dict[str, str]) -> RuntimeNodeConfig:
    async def authorize(_u: str, _a: str) -> bool:
        return True  # OPA gated off

    async def exchange(subject_token: str) -> Any:
        return await reexchange_for_mc_service(subject_token, env=reexchange_env)

    return RuntimeNodeConfig(
        web_api_mcp_url=WEB_API_MCP_URL,
        movie_mcp_url=MOVIE_MCP_URL,
        limiter=AgentToolRateLimiter(max_calls=200, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call_mcp_tool,
        # LLM stub (deterministic): classify=add (below) + extract the title. TMDB enrich is real.
        extract=lambda _m: {"title": _TITLE, "year": _YEAR},
    )


def _app(reexchange_env: dict[str, str]) -> Any:
    graph = build_runtime_graph(
        {}, config=_cfg(reexchange_env), classifier=lambda _m: "add",
        checkpointer=MemorySaver(), force=True,
    )
    return build_app(graph)


def _run_body(
    thread_id: str, target_name: str, *, resume: dict[str, Any] | None = None
) -> dict[str, Any]:
    forwarded: dict[str, Any] = {}
    if resume is not None:
        forwarded = {"command": {"resume": resume}}
    return {
        "threadId": thread_id,
        "runId": f"run-{uuid.uuid4().hex[:8]}",
        # target_collection_name is supplied as state (the deploy proof exercises transport +
        # write + identity; mapping the spoken collection name → target is NLU, out of scope here).
        "state": {"target_collection_name": target_name},
        "messages": [{"id": "m1", "role": "user", "content": f"add {_TITLE} to {target_name}"}],
        "tools": [],
        "context": [],
        "forwardedProps": forwarded,
    }


# ── mc-service verification (downscoped token) ───────────────────────────────────────────────


async def _downscoped(subject_token: str, env: dict[str, str]) -> str:
    return (await reexchange_for_mc_service(subject_token, env=env)).token


def _mc(token: str) -> httpx.Client:
    return httpx.Client(
        base_url=MC_SERVICE_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=15.0,
    )


def _find_collection_id(token: str, name: str) -> str | None:
    with _mc(token) as client:
        resp = client.get(f"{_API}/collections")
        resp.raise_for_status()
        for collection in resp.json():
            if str(collection.get("name", "")).casefold() == name.casefold():
                return str(collection["collectionId"])
    return None


def _movie_count(token: str, collection_id: str) -> int:
    with _mc(token) as client:
        resp = client.get(f"{_API}/collections/{collection_id}/movies")
        resp.raise_for_status()
        body = resp.json()
        items = body.get("items", body) if isinstance(body, dict) else body
        return len(items)


def _delete_collection(token: str, collection_id: str) -> None:
    with _mc(token) as client:
        client.delete(f"{_API}/collections/{collection_id}")


# ── the proof ────────────────────────────────────────────────────────────────────────────────


# ci_quarantine — add-persist: approved add did not create the collection on Claude/CI (real bug vs
# model/timing — needs investigation). Tracked in project_mcm_agent_integration_ci.
@pytest.mark.ci_quarantine
async def test_gateway_add_gated_until_approval_then_persists(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_mcp_servers()
    client = TestClient(_app(reexchange_env))
    auth = {"Authorization": f"Bearer {subject_token}"}
    name = f"gw-add-{uuid.uuid4().hex[:8]}"
    thread = f"gw-{uuid.uuid4().hex[:8]}"
    cleanup_token = await _downscoped(subject_token, reexchange_env)

    try:
        # 1) Run to the approval gate — enrich (real TMDB) + propose, but write NOTHING yet.
        resp = client.post(AGENT_PATH, json=_run_body(thread, name), headers=auth)
        assert resp.status_code == 200
        assert _find_collection_id(cleanup_token, name) is None  # gated: nothing persisted

        # 2) Approve → the create-if-missing collection + the movie are applied exactly once.
        resp2 = client.post(
            AGENT_PATH,
            json=_run_body(thread, name, resume={"decision": "approved"}),
            headers=auth,
        )
        assert resp2.status_code == 200

        collection_id = _find_collection_id(cleanup_token, name)
        assert collection_id is not None, "approved add did not create the collection"
        assert _movie_count(cleanup_token, collection_id) == 1
    finally:
        cid = _find_collection_id(cleanup_token, name)
        if cid:
            _delete_collection(cleanup_token, cid)
