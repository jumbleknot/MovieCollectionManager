"""T045 — RBAC/DAC denial parity + cross-user/admin guard (SC-003, FR-011, FR-012).

Proves the assistant can NEVER exceed the calling user's own permissions, against the REAL
stack (movie-mcp → mc-service DAC from feature 011 + real Keycloak RFC 8693 exchange):

1. **Cross-user denial parity** — a second user owns a collection; the agent run for `testuser`
   (downscoped token) cannot add to it, and `testuser` is denied that collection *identically*
   via the direct API (404 — feature 011 IDOR parity). The agent gains nothing the user couldn't
   do directly (FR-011/FR-012/SC-003).
2. **No privilege escalation** — the gateway-exchanged downscoped token grants no role the
   subject token lacks (effective roles ⊆ subject roles; no admin gained), and carries the
   `agent_origin` provenance marker for mc-service/OPA policy.

Skips cleanly without the live stack / creds (real deps, never cassetted — constitution).

Run:
  cd mcp-servers/movie-mcp && MC_MCP_PORT=8766 MC_MCP_HOST=127.0.0.1 \
      MC_SERVICE_URL=http://localhost:3001 uv run python -m src.server
  MOVIE_MCP_URL=http://127.0.0.1:8766/mcp pnpm nx test:integration movie-assistant -- -k authz
"""

from __future__ import annotations

import base64
import json
import os
import sys
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

# `kc_admin` shares the Keycloak/admin helpers (from conftest is ambiguous across two conftests).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kc_admin  # noqa: E402
import redis.asyncio as redis  # noqa: E402
from langgraph.checkpoint.memory import MemorySaver  # noqa: E402

from src.graph import build_graph  # noqa: E402
from src.proposals import EnrichedMovieCandidate, to_movie_payload  # noqa: E402
from src.runtime_nodes import RuntimeNodeConfig, build_runtime_nodes  # noqa: E402
from src.tools.agent_rate_limit import AgentToolRateLimiter  # noqa: E402
from src.tools.identity import DownscopedTokenCache, acquire_downscoped_token  # noqa: E402
from src.tools.mcp_tools import (  # noqa: E402
    McpServerConfig,
    call_mcp_tool,
    invoke_tool,
    list_mcp_tools,
)
from src.tools.token_exchange import reexchange_for_mc_service  # noqa: E402

MOVIE_MCP_URL = os.environ.get("MOVIE_MCP_URL", "http://127.0.0.1:8766/mcp")
SPREADSHEET_MCP_URL = os.environ.get("SPREADSHEET_MCP_URL", "http://127.0.0.1:8767/mcp")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
MC_SERVICE_URL = kc_admin.MC_SERVICE_URL
_API = "/api/v1"


def _claims(jwt: str) -> dict[str, Any]:
    payload = jwt.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def _effective_roles(claims: dict[str, Any]) -> set[str]:
    """Realm roles + client roles (namespaced) — the full effective grant in the token."""
    roles = {f"realm:{r}" for r in claims.get("realm_access", {}).get("roles", [])}
    for client, access in (claims.get("resource_access") or {}).items():
        roles |= {f"{client}:{r}" for r in access.get("roles", [])}
    return roles


async def _require_movie_mcp() -> None:
    try:
        await list_mcp_tools(MOVIE_MCP_URL)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"movie-mcp not reachable at {MOVIE_MCP_URL}: {exc}")


async def _downscoped(subject_token: str, env: dict[str, str]) -> str:
    return (await reexchange_for_mc_service(subject_token, env=env)).token


# ── second-user provisioning (a collection testuser does NOT own) ────────────────────────────


@pytest.fixture
def other_users_collection() -> Iterator[str]:
    """Provision a throwaway second user, create a collection they own, yield its id; tear down."""
    if not kc_admin.ROPC_CLIENT_ID or not kc_admin.ROPC_CLIENT_SECRET:
        pytest.skip("ROPC creds not set — needs the live stack")
    try:
        admin = kc_admin.admin_token()
    except httpx.HTTPError as exc:
        pytest.skip(f"Keycloak admin unreachable: {exc}")

    username = f"t045-other-{uuid.uuid4().hex[:8]}"
    password = "OtherPass1!ok"  # noqa: S105 (throwaway test user)
    uid = kc_admin.create_user(admin, username, password)
    collection_id: str | None = None
    owner_token: str | None = None
    try:
        kc_admin.assign_app_role(admin, uid, "mc-user")
        login = kc_admin.ropc_token(username, password)
        if login.status_code != 200:
            pytest.skip(f"second-user ROPC login failed ({login.status_code})")
        owner_token = str(login.json()["access_token"])
        resp = httpx.post(
            f"{MC_SERVICE_URL}{_API}/collections",
            headers={"Authorization": f"Bearer {owner_token}", "Content-Type": "application/json"},
            json={"name": f"other-{uuid.uuid4().hex[:8]}"}, timeout=15.0,
        )
        if resp.status_code != 201:
            pytest.skip(f"second user could not create a collection ({resp.status_code})")
        collection_id = str(resp.json()["collectionId"])
        yield collection_id
    finally:
        if collection_id and owner_token:
            httpx.request(
                "DELETE", f"{MC_SERVICE_URL}{_API}/collections/{collection_id}",
                headers={"Authorization": f"Bearer {owner_token}"}, timeout=15.0,
            )
        kc_admin.delete_user(admin, uid)


# ── agent / direct helpers (as testuser) ────────────────────────────────────────────────────


async def _agent_add(subject_token: str, env: dict[str, str], collection_id: str) -> Any:
    """The agent's add path (organizer allowlist) for `testuser` against `collection_id`."""
    cache = DownscopedTokenCache()
    user_id = str(_claims(subject_token)["sub"])

    async def authorize(_u: str, _a: str) -> bool:
        return True

    async def exchange(st: str) -> Any:
        return await reexchange_for_mc_service(st, env=env)

    async def acquire(st: str, aud: str) -> str:
        return await acquire_downscoped_token(
            st, user_id=user_id, authorize=authorize, exchange=exchange, cache=cache, audience=aud
        )

    candidate = EnrichedMovieCandidate.model_validate(
        {"sourceId": "tmdb:603", "title": "The Matrix", "year": 1999,
         "genres": ["Science Fiction"], "language": "English", "matchConfidence": "exact"}
    )
    return await invoke_tool(
        agent="organizer", tool_name="add_movie",
        arguments={"collectionId": collection_id, "movie": to_movie_payload(candidate),
                   "idempotencyKey": "t045"},
        server=McpServerConfig("movie-mcp", MOVIE_MCP_URL, needs_token=True),
        subject_token=subject_token, call=call_mcp_tool,
        limiter=AgentToolRateLimiter(max_calls=50, window_seconds=60), acquire_token=acquire,
    )


def _direct_get_status(token: str, collection_id: str) -> int:
    resp = httpx.get(
        f"{MC_SERVICE_URL}{_API}/collections/{collection_id}",
        headers={"Authorization": f"Bearer {token}"}, timeout=15.0,
    )
    return resp.status_code


# ── tests ───────────────────────────────────────────────────────────────────────────────────


async def test_agent_cannot_reach_another_users_collection_denied_identically(
    subject_token: str, reexchange_env: dict[str, str], other_users_collection: str
) -> None:
    await _require_movie_mcp()
    collection_id = other_users_collection  # owned by a different user (fixture created it)

    # Direct API: testuser's own downscoped token is denied the cross-user collection with a
    # 404 (feature 011 DAC/IDOR parity — never 403, which would leak existence).
    direct_status = _direct_get_status(
        await _downscoped(subject_token, reexchange_env), collection_id
    )
    assert direct_status == 404

    # Agent path: the same user, via movie-mcp, is denied the cross-user write identically —
    # the assistant gains nothing the user couldn't do directly (FR-011/FR-012/SC-003).
    outcome = await _agent_add(subject_token, reexchange_env, collection_id)
    assert outcome.ok is False


async def test_exchanged_token_grants_no_role_beyond_the_user(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    exchanged = await _downscoped(subject_token, reexchange_env)
    subject_roles = _effective_roles(_claims(subject_token))
    exchanged_roles = _effective_roles(_claims(exchanged))

    # SC-003: the agent acts AS the user — no escalation. Effective roles never grow.
    assert exchanged_roles <= subject_roles
    # No admin capability is conjured for a non-admin user.
    assert "movie-collection-manager:mc-admin" not in exchanged_roles
    # The token is marked agent-origin so mc-service/OPA can police agent calls (research R3).
    assert _claims(exchanged).get("agent_origin") is True


# ── T038a / T046a: import & export reach ONLY the user's own collections (FR-030) ─────────────


@pytest.fixture
def other_users_named_collection() -> Iterator[dict[str, str]]:
    """Like `other_users_collection` but yields {id, name, token} so import/export authz can
    reference the other user's collection by NAME and verify it is untouched via its owner."""
    if not kc_admin.ROPC_CLIENT_ID or not kc_admin.ROPC_CLIENT_SECRET:
        pytest.skip("ROPC creds not set — needs the live stack")
    try:
        admin = kc_admin.admin_token()
    except httpx.HTTPError as exc:
        pytest.skip(f"Keycloak admin unreachable: {exc}")

    username = f"t038a-other-{uuid.uuid4().hex[:8]}"
    password = "OtherPass1!ok"  # noqa: S105 (throwaway test user)
    uid = kc_admin.create_user(admin, username, password)
    collection_id: str | None = None
    owner_token: str | None = None
    try:
        kc_admin.assign_app_role(admin, uid, "mc-user")
        login = kc_admin.ropc_token(username, password)
        if login.status_code != 200:
            pytest.skip(f"second-user ROPC login failed ({login.status_code})")
        owner_token = str(login.json()["access_token"])
        name = f"other-{uuid.uuid4().hex[:8]}"
        resp = httpx.post(
            f"{MC_SERVICE_URL}{_API}/collections",
            headers={"Authorization": f"Bearer {owner_token}", "Content-Type": "application/json"},
            json={"name": name}, timeout=15.0,
        )
        if resp.status_code != 201:
            pytest.skip(f"second user could not create a collection ({resp.status_code})")
        collection_id = str(resp.json()["collectionId"])
        yield {"id": collection_id, "name": name, "token": owner_token}
    finally:
        if collection_id and owner_token:
            httpx.request(
                "DELETE", f"{MC_SERVICE_URL}{_API}/collections/{collection_id}",
                headers={"Authorization": f"Bearer {owner_token}"}, timeout=15.0,
            )
        kc_admin.delete_user(admin, uid)


def _live_cfg(reexchange_env: dict[str, str]) -> RuntimeNodeConfig:
    async def authorize(_u: str, _a: str) -> bool:
        return True

    async def exchange(st: str) -> Any:
        return await reexchange_for_mc_service(st, env=reexchange_env)

    return RuntimeNodeConfig(
        web_api_mcp_url="http://unused/mcp", movie_mcp_url=MOVIE_MCP_URL,
        spreadsheet_mcp_url=SPREADSHEET_MCP_URL,
        limiter=AgentToolRateLimiter(max_calls=200, window_seconds=60),
        cache=DownscopedTokenCache(), authorize=authorize, exchange=exchange, call=call_mcp_tool,
    )


def _graph(reexchange_env: dict[str, str], intent: str) -> Any:
    nodes = build_runtime_nodes(_live_cfg(reexchange_env))
    return build_graph(classifier=lambda _m: intent, checkpointer=MemorySaver(), **nodes)


def _export_handle(result: dict[str, Any]) -> str | None:
    for msg in result.get("messages", []) or []:
        for call in getattr(msg, "tool_calls", None) or []:
            if call.get("name") == "download_export":
                return str(call.get("args", {}).get("handle") or "") or None
    return None


def _other_movie_count(token: str, collection_id: str) -> int:
    resp = httpx.get(
        f"{MC_SERVICE_URL}{_API}/collections/{collection_id}/movies",
        headers={"Authorization": f"Bearer {token}"}, timeout=15.0,
    )
    resp.raise_for_status()
    body = resp.json()
    return len(body.get("items", body) if isinstance(body, dict) else body)


async def test_export_cannot_select_another_users_collection(
    subject_token: str, reexchange_env: dict[str, str], other_users_named_collection: dict[str, str]
) -> None:
    """T046a: export returns only the requester's collections — explicitly requesting another
    user's collection id yields no workbook (its id is not in the requester's list)."""
    await _require_movie_mcp()
    user_id = str(_claims(subject_token)["sub"])
    config = {
        "configurable": {
            "thread_id": f"t046a-{uuid.uuid4().hex[:8]}", "subject_token": subject_token,
            "user_id": user_id, "export_collection_ids": [other_users_named_collection["id"]],
        }
    }
    result = await _graph(reexchange_env, "export").ainvoke(
        {"messages": [("user", "export that collection")]}, config
    )
    # select_export_collections filters the requested id against the requester's OWN collections,
    # so another user's id is dropped → no download handle is ever produced (FR-030).
    assert _export_handle(result) is None


async def test_import_cannot_write_to_another_users_collection(
    subject_token: str, reexchange_env: dict[str, str], other_users_named_collection: dict[str, str]
) -> None:
    """T038a: an import whose tab name matches another user's collection cannot write to it — the
    tab→collection match only considers the requester's OWN collections (FR-030)."""
    await _require_movie_mcp()
    try:
        await list_mcp_tools(SPREADSHEET_MCP_URL)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"spreadsheet-mcp not reachable at {SPREADSHEET_MCP_URL}: {exc}")

    other = other_users_named_collection
    handle = uuid.uuid4().hex
    csv = b"Title,Year,Video Type\nIntruderFilm,1999,Movie\n"
    client = redis.from_url(REDIS_URL, decode_responses=False)
    try:
        await client.set("import:file:" + handle, csv, ex=300)
    finally:
        await client.aclose()

    user_id = str(_claims(subject_token)["sub"])
    config = {
        "configurable": {
            "thread_id": f"t038a-{uuid.uuid4().hex[:8]}", "subject_token": subject_token,
            "user_id": user_id, "file_handle": handle, "filename": f"{other['name']}.csv",
        }
    }
    # The requester does NOT own a collection named like the other user's → the tab is unresolved →
    # the node asks for a target (no write), never silently targeting the other user's collection.
    result = await _graph(reexchange_env, "import").ainvoke(
        {"messages": [("user", "import my movies from this spreadsheet")]}, config
    )
    assert "__interrupt__" not in result  # paused on a question, not the write gate
    assert _other_movie_count(other["token"], other["id"]) == 0  # untouched (FR-030)
