"""T036 — US1 add flow LIVE: interrupt/resume + idempotency + create-if-missing.

The heaviest US1 integration: the REAL organizer + approval_gate nodes (from the production
factory `build_runtime_nodes`) drive writes through the Slice-F2 streamable-HTTP transport to a
running movie-mcp → real mc-service, with a REAL Keycloak RFC 8693 downscoped token per call.
The curator is stubbed with a deterministic candidate (TMDB enrichment is covered by T035) so
this test isolates the write/approval path. The subject token reaches the real nodes via
`config["configurable"]` (the production wiring — validates the config-injection path live).

Proves: create-if-missing surfaces create+add in ONE approval; approve applies once; reject
persists nothing; a duplicate retry leaves exactly one movie (SC-006 at-most-once, via
mc-service uniqueness). Skips cleanly without the live stack (movie-mcp + mc-service + Keycloak
with T012 applied + ROPC/service creds) — real deps, never cassetted (constitution).

Run:
  cd mcp-servers/movie-mcp && MC_MCP_PORT=8766 MC_MCP_HOST=127.0.0.1 \
      MC_SERVICE_URL=http://localhost:3001 uv run python -m src.server
  MOVIE_MCP_URL=http://127.0.0.1:8766/mcp pnpm nx test:integration movie-assistant -- -k add_flow
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from typing import Any

import httpx
import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src.graph import build_graph
from src.proposals import EnrichedMovieCandidate
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


def _candidate() -> EnrichedMovieCandidate:
    return EnrichedMovieCandidate.model_validate(
        {
            "source": "tmdb", "sourceId": "tmdb:603", "title": "The Matrix", "year": 1999,
            "overview": "A hacker learns the truth about his reality.",
            "genres": ["Science Fiction"], "posterUrl": "http://img/p.jpg",
            "language": "English", "matchConfidence": "exact",
        }
    )


def _stub_curator(candidate: EnrichedMovieCandidate) -> Any:
    async def curator(state: dict[str, Any]) -> dict[str, Any]:
        return {
            "messages": [AIMessage(content="Here's a preview.")],
            "candidate": candidate,
            "match_confidence": "exact",
        }

    return curator


def _live_cfg(reexchange_env: dict[str, str]) -> RuntimeNodeConfig:
    async def authorize(_user: str, _aud: str) -> bool:
        return True  # OPA gated off (not deployed) — allow

    async def exchange(subject_token: str) -> Any:
        return await reexchange_for_mc_service(subject_token, env=reexchange_env)

    return RuntimeNodeConfig(
        web_api_mcp_url="http://unused/mcp",  # curator is stubbed; no web-api-mcp call
        movie_mcp_url=MOVIE_MCP_URL,
        limiter=AgentToolRateLimiter(max_calls=200, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call_mcp_tool,
        extract=lambda _m: {},
    )


def _graph(cfg: RuntimeNodeConfig, candidate: EnrichedMovieCandidate) -> Any:
    nodes = build_runtime_nodes(cfg)
    nodes["curator"] = _stub_curator(candidate)  # deterministic candidate (no TMDB)
    return build_graph(classifier=lambda _m: "add", checkpointer=MemorySaver(), **nodes)


def _config(thread: str, subject_token: str) -> dict[str, Any]:
    return {
        "configurable": {
            "thread_id": thread,
            "subject_token": subject_token,
            "user_id": _sub(subject_token),
        }
    }


# 047 US4 extended the single ownership question into a chain (ownership → media formats →
# ripped → rip qualities). A test that only wants to reach the approval gate answers whatever
# stage the flow is on, with neutral answers that record nothing.
_CHAIN_ANSWERS = {
    # 059 US2 put "Is this a children's movie?" at the FRONT of the chain. Answered neutrally so
    # a test about idempotency or persistence is not also asserting a children's answer.
    "awaiting_childrens": "no",
    "awaiting_media": "Selected: none",
    "awaiting_ripped": "no",
    "awaiting_rip_quality": "Selected: none",
}


async def _add_and_own(
    graph: Any, config: dict[str, Any], name: str, answer: str = "yes"
) -> Any:
    """Drive the add through the whole ownership chain to the approval interrupt.

    040 US4 made the add ask "Do you own this?" BEFORE the approval gate; 047 US4 extended that
    into a chain; 059 US2 added a question ahead of all of them. Turn 1 pauses at
    `awaiting_childrens` (no interrupt); each following turn answers the stage the flow is on.
    Returns the paused-at-approval result — the drop-in replacement for the pre-US4 single add
    `ainvoke`.

    `answer` is the OWNERSHIP answer and is matched to its stage BY NAME, so 059's extra question
    lengthens the walk without redirecting the caller's "yes"/"no" onto a different question.
    """
    first = await graph.ainvoke(
        {"messages": [("user", f"add The Matrix to {name}")], "target_collection_name": name},
        config,
    )
    assert "__interrupt__" not in first  # paused for a chain question, not the approval gate
    # The chain's FIRST pause, asserted by name rather than softened to "some stage" — the
    # ordering is the guarantee 059 US2 is about, and a relaxed assertion would stop proving it.
    assert first.get("add_stage") == "awaiting_childrens"

    result = first
    for _ in range(6):  # bounded: a stage that never advances fails loudly, not by hanging
        stage = str(result.get("add_stage") or "")
        if stage == "awaiting_ownership":
            reply = answer
        elif stage in _CHAIN_ANSWERS:
            reply = _CHAIN_ANSWERS[stage]
        else:
            return result
        result = await graph.ainvoke({"messages": [("user", reply)]}, config)
    return result


# ── mc-service helpers (verify persisted state with a downscoped token) ──────────────────────


async def _downscoped(subject_token: str, reexchange_env: dict[str, str]) -> str:
    return (await reexchange_for_mc_service(subject_token, env=reexchange_env)).token


def _mc(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=MC_SERVICE_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=15.0,
    )


async def _find_collection_id(token: str, name: str) -> str | None:
    async with _mc(token) as client:
        resp = await client.get(f"{_API}/collections")
        resp.raise_for_status()
        for collection in resp.json():
            if str(collection.get("name", "")).casefold() == name.casefold():
                return str(collection["collectionId"])
    return None


async def _movie_count(token: str, collection_id: str) -> int:
    return len(await _movies(token, collection_id))


async def _movies(token: str, collection_id: str) -> list[dict[str, Any]]:
    async with _mc(token) as client:
        resp = await client.get(f"{_API}/collections/{collection_id}/movies")
        resp.raise_for_status()
        body = resp.json()
        items = body.get("items", body) if isinstance(body, dict) else body
        return list(items)


async def _delete_collection(token: str, collection_id: str) -> None:
    async with _mc(token) as client:
        await client.delete(f"{_API}/collections/{collection_id}")  # cascade-deletes movies


# ── tests ───────────────────────────────────────────────────────────────────────────────────


async def test_create_if_missing_adds_movie_once_on_approval(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    cfg = _live_cfg(reexchange_env)
    name = f"t036-create-{uuid.uuid4().hex[:8]}"
    graph = _graph(cfg, _candidate())
    config = _config(f"t036-create-{uuid.uuid4().hex[:8]}", subject_token)

    paused = await _add_and_own(graph, config, name)
    assert "__interrupt__" in paused
    preview = paused["__interrupt__"][0].value
    ops = {item["operation"] for item in preview["items"]}
    assert ops == {"create_collection", "add"}  # create-if-missing surfaces BOTH in one preview

    cleanup_token = await _downscoped(subject_token, reexchange_env)
    try:
        final = await graph.ainvoke(Command(resume={"decision": "approved"}), config)
        assert final["status"] == "completed"

        collection_id = await _find_collection_id(cleanup_token, name)
        assert collection_id is not None, "create-if-missing did not create the collection"
        assert await _movie_count(cleanup_token, collection_id) == 1  # applied exactly once
    finally:
        cid = await _find_collection_id(cleanup_token, name)
        if cid:
            await _delete_collection(cleanup_token, cid)


async def test_added_tmdb_movie_carries_external_id_url(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    # 013 US5 (T042): an assistant-added TMDB movie persists externalIds[].url =
    # https://www.themoviedb.org/movie/<id> (proposals.to_movie_payload). Verified through the
    # REAL write path (organizer → movie-mcp → mc-service) and read back with a downscoped token.
    await _require_movie_mcp()
    cfg = _live_cfg(reexchange_env)
    name = f"us5-link-{uuid.uuid4().hex[:8]}"
    graph = _graph(cfg, _candidate())  # candidate source_id "tmdb:603"
    config = _config(f"us5-link-{uuid.uuid4().hex[:8]}", subject_token)
    cleanup_token = await _downscoped(subject_token, reexchange_env)

    try:
        await _add_and_own(graph, config, name)
        final = await graph.ainvoke(Command(resume={"decision": "approved"}), config)
        assert final["status"] == "completed"

        collection_id = await _find_collection_id(cleanup_token, name)
        assert collection_id is not None
        movies = await _movies(cleanup_token, collection_id)
        assert len(movies) == 1
        ext = movies[0].get("externalIds") or []
        tmdb = next((e for e in ext if e.get("system") == "tmdb"), None)
        assert tmdb is not None, f"no tmdb external id on the added movie: {ext}"
        assert tmdb.get("url") == "https://www.themoviedb.org/movie/603"
    finally:
        cid = await _find_collection_id(cleanup_token, name)
        if cid:
            await _delete_collection(cleanup_token, cid)


async def test_reject_persists_nothing(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    cfg = _live_cfg(reexchange_env)
    name = f"t036-reject-{uuid.uuid4().hex[:8]}"
    graph = _graph(cfg, _candidate())
    config = _config(f"t036-reject-{uuid.uuid4().hex[:8]}", subject_token)

    paused = await _add_and_own(graph, config, name)
    assert "__interrupt__" in paused

    final = await graph.ainvoke(Command(resume={"decision": "rejected"}), config)
    assert final["status"] == "completed"

    token = await _downscoped(subject_token, reexchange_env)
    assert await _find_collection_id(token, name) is None  # FR-007: zero writes on reject


async def test_duplicate_retry_persists_one_movie(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    # SC-006: a duplicate-submission retry leaves exactly one persisted change. mc-service's
    # per-collection movie uniqueness rejects the second add (the deterministic idempotency key
    # is the forward-compatible basis); the batch is never duplicated.
    await _require_movie_mcp()
    cfg = _live_cfg(reexchange_env)
    name = f"t036-dup-{uuid.uuid4().hex[:8]}"
    cleanup_token = await _downscoped(subject_token, reexchange_env)

    try:
        finals = []
        for attempt in range(2):
            graph = _graph(cfg, _candidate())
            config = _config(f"t036-dup-{attempt}-{uuid.uuid4().hex[:8]}", subject_token)
            await _add_and_own(graph, config, name)
            finals.append(await graph.ainvoke(Command(resume={"decision": "approved"}), config))

        collection_id = await _find_collection_id(cleanup_token, name)
        assert collection_id is not None
        assert await _movie_count(cleanup_token, collection_id) == 1  # exactly one, not two

        # T024a: the second approval re-applies the same items; mc-service 409s → the gate
        # classifies them as skipped_duplicate (not failed) so the user sees "already up to date".
        second = finals[1]["apply_result"]
        assert second.skipped_item_ids  # the duplicate add (and re-create) are skipped
        assert not second.failed_item_ids
        assert "skipped" in finals[1]["messages"][-1].content.lower()
    finally:
        cid = await _find_collection_id(cleanup_token, name)
        if cid:
            await _delete_collection(cleanup_token, cid)


# ── 047 US4 (T085): the ownership details land on the persisted movie ────────────────────────
#
# The unit tier proves the stage chain and the payload. What only this tier can prove is that
# the values published by mc-service, offered to the member, and sent back through movie-mcp are
# the SAME values — and that mc-service stores exactly them.
#
# That round trip is the whole point of RQ-4: if the published list and the accepted list ever
# diverge, every ownership add fails validation, and no amount of agent-side testing would show it.


async def _published_media_formats(token: str) -> list[str]:
    async with _mc(token) as client:
        resp = await client.get(f"{_API}/movie-metadata")
        resp.raise_for_status()
        return list(resp.json()["mediaFormats"])


async def test_ownership_details_persist_exactly_the_chosen_values(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    await _require_movie_mcp()
    cfg = _live_cfg(reexchange_env)
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t047-own-{uuid.uuid4().hex[:8]}"

    formats = await _published_media_formats(token)
    assert formats, "mc-service published no media formats"
    chosen_media = formats[:2]
    chosen_quality = formats[-1:]

    graph = _graph(cfg, _candidate())
    config = _config(f"{name}-own", subject_token)

    first = await graph.ainvoke(
        {"messages": [("user", f"add The Matrix to {name}")], "target_collection_name": name},
        config,
    )
    # 059 US2: the children's question opens the chain; the ownership question follows it. The
    # turn is ADDED — this test walks the sequence deliberately, stage by stage, and that is
    # exactly what must keep being proved.
    assert first.get("add_stage") == "awaiting_childrens"

    ownership_turn = await graph.ainvoke({"messages": [("user", "no")]}, config)
    assert ownership_turn.get("add_stage") == "awaiting_ownership"

    # Yes → the format question, built from the values mc-service just published.
    media_turn = await graph.ainvoke({"messages": [("user", "yes")]}, config)
    assert media_turn.get("add_stage") == "awaiting_media"
    offered = [
        o["value"]
        for m in media_turn["messages"]
        for c in (getattr(m, "tool_calls", None) or [])
        if c["name"] == "render_multi_select"
        for o in c["args"]["options"]
    ]
    assert offered == formats, "the assistant offered values the domain did not publish"

    ripped_turn = await graph.ainvoke(
        {"messages": [("user", f"Selected: {', '.join(chosen_media)}")]}, config
    )
    assert ripped_turn.get("add_stage") == "awaiting_ripped"

    quality_turn = await graph.ainvoke({"messages": [("user", "yes")]}, config)
    assert quality_turn.get("add_stage") == "awaiting_rip_quality"

    paused = await graph.ainvoke(
        {"messages": [("user", f"Selected: {', '.join(chosen_quality)}")]}, config
    )
    assert "__interrupt__" in paused, "the completed chain must reach the approval gate"

    collection_id: str | None = None
    try:
        await graph.ainvoke(Command(resume={"decision": "approved"}), config)

        collection_id = await _find_collection_id(token, name)
        assert collection_id is not None, "the collection was not created"
        movies = await _movies(token, collection_id)
        assert len(movies) == 1

        movie = movies[0]
        assert movie["owned"] is True
        assert movie["ripped"] is True
        # EXACTLY the chosen values — mc-service accepted every published value it was sent.
        assert movie["ownedMedia"] == chosen_media
        assert movie["ripQuality"] == chosen_quality
    finally:
        if collection_id:
            await _delete_collection(token, collection_id)


async def test_ownership_no_records_neither_formats_nor_qualities(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    """US4-AC1: answering "no" adds it not owned, with nothing else recorded."""
    await _require_movie_mcp()
    cfg = _live_cfg(reexchange_env)
    token = await _downscoped(subject_token, reexchange_env)
    name = f"t047-notowned-{uuid.uuid4().hex[:8]}"

    graph = _graph(cfg, _candidate())
    config = _config(f"{name}-own", subject_token)

    paused = await _add_and_own(graph, config, name, answer="no")
    assert "__interrupt__" in paused

    collection_id: str | None = None
    try:
        await graph.ainvoke(Command(resume={"decision": "approved"}), config)
        collection_id = await _find_collection_id(token, name)
        assert collection_id is not None
        movies = await _movies(token, collection_id)
        assert len(movies) == 1
        assert movies[0]["owned"] is False
        assert movies[0]["ownedMedia"] == []
        assert movies[0]["ripped"] is False
        assert movies[0]["ripQuality"] == []
    finally:
        if collection_id:
            await _delete_collection(token, collection_id)
