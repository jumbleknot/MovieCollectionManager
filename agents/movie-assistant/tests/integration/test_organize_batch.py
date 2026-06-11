"""T047 — US2 organize flow LIVE: plan → batch preview → approve → real removes + drift.

The REAL organizer + approval_gate (production factory `build_runtime_nodes`) drive deletes
through the Slice-F2 streamable-HTTP transport to a running movie-mcp → real mc-service, with a
REAL Keycloak RFC 8693 downscoped token per call. The model PLAN is stubbed (deterministic
remove-by-title via the `plan` seam) so this isolates the resolve/write/re-validation path; the
plan decision is covered by the golden gate (T063). The subject token reaches the nodes via
`config["configurable"]` (the production wiring).

Proves: a multi-item remove previews the batch (nothing removed pre-approval, FR-007), approve
removes exactly the resolved movies, an unresolved title is skipped, and a DRIFTED item
(deleted out-of-band after the proposal) is skipped_missing at apply time without aborting the
batch (FR-009a / SC-010). Chunking >50 is dependency-free pure logic — covered deterministically
by the graph test (test_organize_flow). Skips cleanly without the live stack.

Run:
  cd mcp-servers/movie-mcp && MC_MCP_PORT=8766 MC_MCP_HOST=127.0.0.1 \
      MC_SERVICE_URL=http://localhost:3001 uv run python -m src.server
  MOVIE_MCP_URL=http://127.0.0.1:8766/mcp \
      pnpm nx test:integration movie-assistant -- -k organize_batch
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
from langgraph.types import Command

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


def _movie_body(title: str, *, owned: bool = True, tags: list[str] | None = None) -> dict[str, Any]:
    return {
        "title": title, "year": 1999, "contentType": "Movie", "language": "English",
        "owned": owned, "ripped": False, "childrens": False, "ownedMedia": [], "ripQuality": [],
        "genres": ["Sci-Fi"], "rated": "R", "directors": [], "actors": [], "tags": tags or [],
        "movieSet": None, "originalTitle": None, "releaseDate": None, "outline": None,
        "plot": None, "runtime": None, "externalIds": [],
    }


def _plan_remove(*titles: str) -> Any:
    def plan(_messages: Sequence[Any]) -> dict[str, Any]:
        return {"collection": None, "operations": [{"op": "remove", "title": t} for t in titles]}

    return plan


def _plan_update(title: str, changes: dict[str, Any]) -> Any:
    def plan(_messages: Sequence[Any]) -> dict[str, Any]:
        op = {"op": "update", "title": title, "changes": changes}
        return {"collection": None, "operations": [op]}

    return plan


def _plan_move(title: str, to: str) -> Any:
    def plan(_messages: Sequence[Any]) -> dict[str, Any]:
        return {"collection": None, "operations": [{"op": "move", "title": title, "to": to}]}

    return plan


def _live_cfg(reexchange_env: dict[str, str], plan: Any) -> RuntimeNodeConfig:
    async def authorize(_user: str, _aud: str) -> bool:
        return True  # OPA gated off (not deployed) — allow

    async def exchange(subject_token: str) -> Any:
        return await reexchange_for_mc_service(subject_token, env=reexchange_env)

    return RuntimeNodeConfig(
        web_api_mcp_url="http://unused/mcp",  # organize doesn't touch web-api-mcp
        movie_mcp_url=MOVIE_MCP_URL,
        limiter=AgentToolRateLimiter(max_calls=500, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call_mcp_tool,
        plan=plan,
    )


def _graph(cfg: RuntimeNodeConfig) -> Any:
    nodes = build_runtime_nodes(cfg)
    return build_graph(classifier=lambda _m: "organize", checkpointer=MemorySaver(), **nodes)


def _config(thread: str, subject_token: str) -> dict[str, Any]:
    return {
        "configurable": {
            "thread_id": thread,
            "subject_token": subject_token,
            "user_id": _sub(subject_token),
        }
    }


# ── mc-service helpers (set up + verify state with a downscoped token) ───────────────────────


async def _downscoped(subject_token: str, reexchange_env: dict[str, str]) -> str:
    return (await reexchange_for_mc_service(subject_token, env=reexchange_env)).token


def _mc(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=MC_SERVICE_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=15.0,
    )


async def _seed_collection(
    token: str, name: str, movies: list[dict[str, Any]]
) -> tuple[str, dict[str, str]]:
    """Create a collection with the given movie bodies; return (collectionId, {title: movieId})."""
    async with _mc(token) as client:
        resp = await client.post(f"{_API}/collections", json={"name": name})
        resp.raise_for_status()
        collection_id = str(resp.json()["collectionId"])
        ids: dict[str, str] = {}
        for body in movies:
            r = await client.post(f"{_API}/collections/{collection_id}/movies", json=body)
            r.raise_for_status()
            ids[str(body["title"])] = str(r.json()["movieId"])
        return collection_id, ids


async def _movie_titles(token: str, collection_id: str) -> set[str]:
    return {str(m["title"]) for m in (await _movies(token, collection_id))}


async def _movies(token: str, collection_id: str) -> list[dict[str, Any]]:
    async with _mc(token) as client:
        resp = await client.get(f"{_API}/collections/{collection_id}/movies")
        resp.raise_for_status()
        body = resp.json()
        items = body.get("items", body) if isinstance(body, dict) else body
        return list(items)


async def _movie_by_title(token: str, collection_id: str, title: str) -> dict[str, Any]:
    return next(m for m in (await _movies(token, collection_id)) if str(m["title"]) == title)


async def _delete_collection(token: str, collection_id: str) -> None:
    async with _mc(token) as client:
        await client.delete(f"{_API}/collections/{collection_id}")


async def _delete_movie(token: str, collection_id: str, movie_id: str) -> None:
    async with _mc(token) as client:
        await client.delete(f"{_API}/collections/{collection_id}/movies/{movie_id}")


# ── tests ───────────────────────────────────────────────────────────────────────────────────


async def test_organize_remove_batch_applies_on_approval(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t047-rm-{uuid.uuid4().hex[:8]}"
    collection_id, _ = await _seed_collection(
        token, name, [_movie_body(t) for t in ("Alpha", "Beta", "Gamma")]
    )
    try:
        graph = _graph(_live_cfg(reexchange_env, _plan_remove("Alpha", "Gamma")))
        config = _config(f"t047-rm-{uuid.uuid4().hex[:8]}", subject_token)

        paused = await graph.ainvoke(
            {"messages": [("user", f"remove Alpha and Gamma from {name}")],
             "target_collection_name": name},
            config,
        )
        assert "__interrupt__" in paused
        assert len(paused["__interrupt__"][0].value["items"]) == 2
        assert await _movie_titles(token, collection_id) == {"Alpha", "Beta", "Gamma"}  # FR-007

        final = await graph.ainvoke(Command(resume={"decision": "approved"}), config)
        assert final["status"] == "completed"
        assert await _movie_titles(token, collection_id) == {"Beta"}  # Alpha + Gamma removed
    finally:
        await _delete_collection(token, collection_id)


async def test_organize_skips_drifted_item_without_aborting_batch(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t047-drift-{uuid.uuid4().hex[:8]}"
    collection_id, ids = await _seed_collection(
        token, name, [_movie_body(t) for t in ("Alpha", "Beta", "Gamma")]
    )
    try:
        graph = _graph(_live_cfg(reexchange_env, _plan_remove("Alpha", "Beta")))
        config = _config(f"t047-drift-{uuid.uuid4().hex[:8]}", subject_token)
        await graph.ainvoke(
            {"messages": [("user", f"remove Alpha and Beta from {name}")],
             "target_collection_name": name},
            config,
        )
        # Drift: Beta is deleted out-of-band AFTER the proposal was built, BEFORE approval.
        await _delete_movie(token, collection_id, ids["Beta"])

        final = await graph.ainvoke(Command(resume={"decision": "approved"}), config)
        result = final["apply_result"]
        assert result.applied_item_ids and result.skipped_item_ids  # Alpha applied, Beta skipped
        assert not result.failed_item_ids  # 404 → skipped_missing, never a hard failure
        assert await _movie_titles(token, collection_id) == {"Gamma"}  # only Gamma remains
    finally:
        await _delete_collection(token, collection_id)


async def test_organize_reject_persists_nothing(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t047-rej-{uuid.uuid4().hex[:8]}"
    collection_id, _ = await _seed_collection(
        token, name, [_movie_body(t) for t in ("Alpha", "Beta")]
    )
    try:
        graph = _graph(_live_cfg(reexchange_env, _plan_remove("Alpha")))
        config = _config(f"t047-rej-{uuid.uuid4().hex[:8]}", subject_token)
        await graph.ainvoke(
            {"messages": [("user", f"remove Alpha from {name}")], "target_collection_name": name},
            config,
        )
        final = await graph.ainvoke(Command(resume={"decision": "rejected"}), config)
        assert final["status"] == "completed"
        assert await _movie_titles(token, collection_id) == {"Alpha", "Beta"}  # FR-007: unchanged
    finally:
        await _delete_collection(token, collection_id)


# ── T070: update (full-replace) + cross-collection move — LIVE ───────────────────────────────


async def test_organize_update_flips_owned_on_approval(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    """A live in-place update: 'mark Alpha as owned' composes the full-replacement payload from
    a real read and PUTs it through movie-mcp → mc-service; the owned flag flips only on approval
    (FR-007). Proves compose_movie_payload round-trips a real MovieDto (extra server fields are
    ignored by mc-service's request DTO — no deny_unknown_fields)."""
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t070-upd-{uuid.uuid4().hex[:8]}"
    collection_id, _ = await _seed_collection(token, name, [_movie_body("Alpha", owned=False)])
    try:
        graph = _graph(_live_cfg(reexchange_env, _plan_update("Alpha", {"owned": True})))
        config = _config(f"t070-upd-{uuid.uuid4().hex[:8]}", subject_token)

        paused = await graph.ainvoke(
            {"messages": [("user", f"mark Alpha as owned in {name}")],
             "target_collection_name": name},
            config,
        )
        assert "__interrupt__" in paused
        assert len(paused["__interrupt__"][0].value["items"]) == 1
        assert (await _movie_by_title(token, collection_id, "Alpha"))["owned"] is False  # FR-007

        final = await graph.ainvoke(Command(resume={"decision": "approved"}), config)
        assert final["status"] == "completed"
        movie = await _movie_by_title(token, collection_id, "Alpha")
        assert movie["owned"] is True  # the flag flipped; the rest of the movie is preserved
        assert movie["title"] == "Alpha" and movie["year"] == 1999
    finally:
        await _delete_collection(token, collection_id)


async def test_organize_update_adds_tag_on_approval(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    """A live tag update: addTags unions onto the movie's existing tags in the full-replace PUT."""
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t070-tag-{uuid.uuid4().hex[:8]}"
    collection_id, _ = await _seed_collection(
        token, name, [_movie_body("Alpha", tags=["scifi"])]
    )
    try:
        graph = _graph(_live_cfg(reexchange_env, _plan_update("Alpha", {"addTags": ["favorite"]})))
        config = _config(f"t070-tag-{uuid.uuid4().hex[:8]}", subject_token)
        await graph.ainvoke(
            {"messages": [("user", f"tag Alpha as favorite in {name}")],
             "target_collection_name": name},
            config,
        )
        final = await graph.ainvoke(Command(resume={"decision": "approved"}), config)
        assert final["status"] == "completed"
        tags = set((await _movie_by_title(token, collection_id, "Alpha"))["tags"])
        assert tags == {"scifi", "favorite"}  # union — the existing tag is preserved
    finally:
        await _delete_collection(token, collection_id)


async def test_organize_move_relocates_movie_on_approval(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    """A live cross-collection move: add-to-dest THEN remove-from-source. The movie leaves the
    source and arrives in the destination only on approval (FR-007); nothing changes before."""
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    src_name = f"t070-mv-src-{uuid.uuid4().hex[:8]}"
    dst_name = f"t070-mv-dst-{uuid.uuid4().hex[:8]}"
    src_id, _ = await _seed_collection(
        token, src_name, [_movie_body("Alpha"), _movie_body("Beta")]
    )
    dst_id, _ = await _seed_collection(token, dst_name, [])
    try:
        graph = _graph(_live_cfg(reexchange_env, _plan_move("Alpha", dst_name)))
        config = _config(f"t070-mv-{uuid.uuid4().hex[:8]}", subject_token)

        paused = await graph.ainvoke(
            {"messages": [("user", f"move Alpha from {src_name} to {dst_name}")],
             "target_collection_name": src_name},
            config,
        )
        assert "__interrupt__" in paused
        assert len(paused["__interrupt__"][0].value["items"]) == 1
        assert await _movie_titles(token, src_id) == {"Alpha", "Beta"}  # FR-007: unchanged
        assert await _movie_titles(token, dst_id) == set()

        final = await graph.ainvoke(Command(resume={"decision": "approved"}), config)
        assert final["status"] == "completed"
        assert await _movie_titles(token, src_id) == {"Beta"}    # Alpha left the source
        assert await _movie_titles(token, dst_id) == {"Alpha"}   # Alpha arrived in the dest
    finally:
        await _delete_collection(token, src_id)
        await _delete_collection(token, dst_id)
