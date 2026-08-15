"""Production-node factory: config-aware curator/organizer/approval_gate (US1 Slice G).

`build_runtime_nodes(cfg)` composes the real MCP-backed nodes from runtime config — the same
closures the curator/organizer integration tests build by hand, but wired once and reading the
per-run subject token from `config["configurable"]` (task-safe, never checkpointed — SC-004).
The graph STAYS tool-free unless production nodes are enabled (both MCP URLs set), so
`build_graph()` defaults are unchanged and SC-005 holds until the deploy cut-over.

These tests exercise the COMPILED graph built via the factory with injected transport
(`call`) + identity (`authorize`/`exchange`) — deterministic, no Keycloak/MCP/mc-service. They
prove (a) the gating predicate, (b) the downscoped-token path reaches movie-mcp calls (acquire
= authorize → exchange) while web-api-mcp calls carry no token, and (c) apply-once on approval.
The LIVE transport/exchange is T036.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src.runtime_nodes import (
    RuntimeNodeConfig,
    _stamp_ui_action_nonce,
    build_runtime_graph,
    build_runtime_nodes,
    production_nodes_enabled,
)
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.mcp_tools import McpCallResult
from src.tools.token_exchange import ExchangedToken

_DETAILS = {
    "source": "tmdb", "sourceId": "tmdb:603", "title": "The Matrix", "year": 1999,
    "overview": "x", "genres": ["Science Fiction"], "posterUrl": "http://x", "language": "English",
}
_EXISTING = [{"collectionId": "0123456789abcdef01234567", "name": "Sci-Fi", "movieCount": 0}]
_DOWNSCOPED = "downscoped-mc-token"


class _Recorder:
    """A fake ToolCallFn that records (tool_name, token) and returns canned MCP results."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], str | None]] = []

    async def __call__(
        self, server_url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        self.calls.append((tool_name, arguments, token))
        if tool_name == "search_title":
            found = {"matchConfidence": "exact", "results": [{"sourceId": "tmdb:603"}]}
            return McpCallResult(False, found, "")
        if tool_name == "get_movie_details":
            return McpCallResult(False, _DETAILS, "")
        if tool_name == "list_collections":
            return McpCallResult(False, _EXISTING, "")
        if tool_name in ("add_movie", "create_collection"):
            written = {"movieId": "m1", "collectionId": _EXISTING[0]["collectionId"]}
            return McpCallResult(False, written, "")
        return McpCallResult(True, None, "unknown tool")


def _cfg(call: Any) -> RuntimeNodeConfig:
    async def authorize(_user: str, _aud: str) -> bool:
        return True

    async def exchange(_subject: str) -> ExchangedToken:
        return ExchangedToken(token=_DOWNSCOPED, expires_in=60)

    return RuntimeNodeConfig(
        web_api_mcp_url="http://web-api-mcp/mcp",
        movie_mcp_url="http://movie-mcp/mcp",
        limiter=AgentToolRateLimiter(max_calls=100, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call,
        extract=lambda _m: {"title": "The Matrix", "year": 1999, "collection": "Sci-Fi"},
    )


def _config(thread: str) -> dict[str, Any]:
    # The gateway/graph-entry populates subject_token + user_id into configurable (never state).
    return {"configurable": {"thread_id": thread, "subject_token": "subj-123", "user_id": "user-1"}}


# 047 US4 extended the single ownership question into a chain (ownership → media formats →
# ripped → rip qualities). A test that only wants to reach the approval gate answers whatever
# stage the flow is on rather than assuming one "yes" suffices.
_CHAIN_ANSWERS = {
    # 059 US2 added this question at the FRONT of the chain. Answered neutrally here so a test
    # about something else is not also asserting a children's answer.
    "awaiting_childrens": "no",
    "awaiting_media": "Selected: none",
    "awaiting_ripped": "no",
    "awaiting_rip_quality": "Selected: none",
}


async def _answer_ownership_chain(graph: Any, cfg: dict[str, Any], answer: str = "yes") -> Any:
    """Answer the ownership question and every follow-up; return the final turn."""
    # 059 US2: the caller's `answer` is the OWNERSHIP answer, which is no longer the first reply
    # — the children's question now comes first. Replies are matched to stages BY NAME rather
    # than by turn order, so inserting a question shifts the sequence without silently
    # redirecting every caller's "yes"/"no" to a different question than it was written for.
    result = await graph.ainvoke(
        {"messages": [("user", _CHAIN_ANSWERS["awaiting_childrens"])]}, cfg
    )
    for _ in range(5):  # bounded: a stage that never advances fails loudly, not by hanging
        stage = str(result.get("add_stage") or "")
        if stage == "awaiting_ownership":
            reply = answer
        elif stage in _CHAIN_ANSWERS:
            reply = _CHAIN_ANSWERS[stage]
        else:
            return result
        result = await graph.ainvoke({"messages": [("user", reply)]}, cfg)
    return result


def test_stamp_ui_action_nonce_adds_nonce_to_ui_action_calls() -> None:
    # 013 Inc5 nav bug: the runtime boundary stamps a per-emission nonce onto a UI-action tool
    # call so the client dedup distinguishes a genuine repeat-navigation from a dock re-mount.
    result = {
        "messages": [
            AIMessage(
                content="Opening.",
                tool_calls=[
                    {"name": "navigate_to_collection", "args": {"collectionId": "c1"}, "id": "x"}
                ],
            )
        ]
    }
    out = _stamp_ui_action_nonce(result, "7")
    assert out["messages"][0].tool_calls[0]["args"]["nonce"] == "7"


def test_stamp_ui_action_nonce_leaves_non_ui_action_tool_calls_untouched() -> None:
    result = {
        "messages": [
            AIMessage(
                content="card",
                tool_calls=[{"name": "render_movie_card", "args": {"title": "X"}, "id": "y"}],
            )
        ]
    }
    out = _stamp_ui_action_nonce(result, "7")
    assert "nonce" not in out["messages"][0].tool_calls[0]["args"]


def test_production_nodes_enabled_requires_both_mcp_urls() -> None:
    assert production_nodes_enabled(
        {"WEB_API_MCP_URL": "http://w/mcp", "MOVIE_MCP_URL": "http://m/mcp"}
    )
    assert not production_nodes_enabled({"WEB_API_MCP_URL": "http://w/mcp"})
    assert not production_nodes_enabled({"MOVIE_MCP_URL": "http://m/mcp"})
    assert not production_nodes_enabled({})


def test_build_runtime_nodes_returns_the_specialist_nodes() -> None:
    nodes = build_runtime_nodes(_cfg(_Recorder()))
    assert set(nodes) == {
        "curator", "organizer", "navigator", "query", "search", "import_collection",
        "export_collection", "approval_gate",
    }


async def test_factory_graph_pauses_at_approval_with_a_proposal() -> None:
    rec = _Recorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "add", checkpointer=MemorySaver(), force=True
    )
    cfg = _config("rt-pause")
    turn1 = await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    assert "__interrupt__" not in turn1  # 040 US4: asks ownership before the approval gate
    result = await _answer_ownership_chain(graph, cfg)  # answer → approval gate
    assert "__interrupt__" in result
    payload = result["__interrupt__"][0].value
    assert payload["type"] == "approval_request"
    # web-api-mcp (curator) calls carry NO token; movie-mcp (organizer list) carries the
    # downscoped token from acquire (authorize -> exchange).
    web_tokens = [t for (name, _a, t) in rec.calls if name in ("search_title", "get_movie_details")]
    assert web_tokens == [None, None]
    list_calls = [t for (name, _a, t) in rec.calls if name == "list_collections"]
    assert list_calls == [_DOWNSCOPED]


async def test_factory_graph_applies_once_with_downscoped_token_on_approval() -> None:
    rec = _Recorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "add", checkpointer=MemorySaver(), force=True
    )
    cfg = _config("rt-approve")
    await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    # 040 US4: answer the ownership question -> the approval gate
    await _answer_ownership_chain(graph, cfg)
    final = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)

    assert final["status"] == "completed"
    add_calls = [(args, tok) for (name, args, tok) in rec.calls if name == "add_movie"]
    assert len(add_calls) == 1  # exactly one add (SC-006)
    assert add_calls[0][0]["collectionId"] == _EXISTING[0]["collectionId"]
    assert add_calls[0][1] == _DOWNSCOPED  # write carried the downscoped mc-service token


async def test_factory_graph_writes_nothing_on_rejection() -> None:
    rec = _Recorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "add", checkpointer=MemorySaver(), force=True
    )
    cfg = _config("rt-reject")
    await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    # 040 US4: answer the ownership question -> the approval gate
    await _answer_ownership_chain(graph, cfg)
    final = await graph.ainvoke(Command(resume={"decision": "rejected"}), cfg)

    assert final["status"] == "completed"
    assert not [name for (name, _a, _t) in rec.calls if name in ("add_movie", "create_collection")]


class _DuplicateRecorder(_Recorder):
    """Like _Recorder, but add_movie surfaces mc-service's 409 (a duplicate add)."""

    async def __call__(
        self, server_url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        if tool_name == "add_movie":
            self.calls.append((tool_name, arguments, token))
            return McpCallResult(True, None, "mc-service-status:409 Duplicate movie")
        return await super().__call__(server_url, tool_name, arguments, token)


async def test_factory_graph_resolves_this_from_config_ui_snapshot() -> None:
    # US3/R15: the sanitized ui_snapshot is bridged into config["configurable"] (NOT state);
    # the runtime organizer wrapper threads it into the node so "add X to this" resolves the
    # on-screen collection — no named collection, no body-borne state.
    rec = _Recorder()
    cfg = _cfg(rec)
    cfg.extract = lambda _m: {"title": "The Matrix", "year": 1999}  # the user named no collection
    graph = build_runtime_graph(
        {}, config=cfg, classifier=lambda _m: "add", checkpointer=MemorySaver(), force=True
    )
    run_config = _config("rt-this")
    run_config["configurable"]["ui_snapshot"] = {
        "current_screen": "collection",
        "collection_id": _EXISTING[0]["collectionId"],
    }
    turn1 = await graph.ainvoke(
        {"messages": [("user", "add The Matrix to this")]}, run_config
    )
    assert "__interrupt__" not in turn1  # 040 US4: asks ownership before the approval gate
    result = await _answer_ownership_chain(graph, run_config)  # answer → gate
    assert "__interrupt__" in result
    payload = result["__interrupt__"][0].value
    assert payload["type"] == "approval_request"
    assert payload["target"]["collection_id"] == _EXISTING[0]["collectionId"]
    # "this" never creates a collection — it resolves an existing one.
    assert [i for i in payload["items"] if i["operation"] == "create_collection"] == []


async def test_factory_graph_duplicate_add_maps_to_skipped_duplicate() -> None:
    # T024a: a 409 from mc-service (the movie is already in the collection) must surface as
    # skipped_duplicate, NOT failed — SC-006 exactly-once already holds; this is the UX label.
    rec = _DuplicateRecorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "add", checkpointer=MemorySaver(), force=True
    )
    cfg = _config("rt-dup")
    await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    # 040 US4: answer the ownership question -> the approval gate
    await _answer_ownership_chain(graph, cfg)
    final = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)

    assert final["status"] == "completed"
    result = final["apply_result"]
    assert result.skipped_item_ids  # the duplicate add is skipped, not failed
    assert not result.failed_item_ids
    assert "skipped" in final["messages"][-1].content.lower()


# ── 047 US4 (T080): the movie-metadata TTL cache ─────────────────────────────────────────────
#
# The published option values are the same for every caller, so fetching them on every add is
# wasted work against the 30-per-60s tool budget. The cache is process-wide, which is safe ONLY
# because the response carries no user data — see the constant's comment in runtime_nodes.py for
# why this must never be copied to a user-scoped read.


class _MetadataRecorder(_Recorder):
    """Counts get_movie_metadata / list_collections calls; can fail the metadata read."""

    def __init__(self, fail_metadata: bool = False) -> None:
        super().__init__()
        self.fail_metadata = fail_metadata
        self.metadata_calls = 0
        self.collection_calls = 0

    async def __call__(
        self, server_url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        if tool_name == "get_movie_metadata":
            self.metadata_calls += 1
            self.calls.append((tool_name, arguments, token))
            if self.fail_metadata:
                return McpCallResult(True, None, "movie-mcp unreachable")
            return McpCallResult(
                False, {"mediaFormats": ["DVD", "Blu-Ray", "Blu-Ray 3D", "UHD Blu-Ray"]}, ""
            )
        if tool_name == "list_collections":
            self.collection_calls += 1
        return await super().__call__(server_url, tool_name, arguments, token)


def _metadata_graph(rec: _MetadataRecorder) -> Any:
    return build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "add", checkpointer=MemorySaver(), force=True
    )


async def _add_through_chain(graph: Any, thread: str) -> Any:
    cfg = _config(thread)
    await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    return await _answer_ownership_chain(graph, cfg)


async def test_metadata_cache_fetches_once_across_adds() -> None:
    from src.runtime_nodes import _reset_movie_metadata_cache

    _reset_movie_metadata_cache()
    try:
        rec = _MetadataRecorder()
        graph = _metadata_graph(rec)

        await _add_through_chain(graph, "meta-cache-1")
        assert rec.metadata_calls == 1, f"expected one metadata read, got {rec.metadata_calls}"

        await _add_through_chain(graph, "meta-cache-2")
        assert rec.metadata_calls == 1, "the second add refetched instead of using the cache"
    finally:
        _reset_movie_metadata_cache()


async def test_metadata_cache_does_not_cache_a_failure() -> None:
    """A transient failure must not suppress the format question for the whole TTL."""
    from src.runtime_nodes import _reset_movie_metadata_cache

    _reset_movie_metadata_cache()
    try:
        rec = _MetadataRecorder(fail_metadata=True)
        graph = _metadata_graph(rec)

        await _add_through_chain(graph, "meta-fail-1")
        await _add_through_chain(graph, "meta-fail-2")

        assert rec.metadata_calls == 2, "a failed read was cached — it must be retried"
    finally:
        _reset_movie_metadata_cache()


async def test_metadata_cache_does_not_extend_to_user_scoped_reads() -> None:
    """Guard the boundary: only get_movie_metadata is cached, never a user-scoped read.

    list_collections must still be called on the second add — if it were cached the same way,
    one member's library would be served to another.
    """
    from src.runtime_nodes import _reset_movie_metadata_cache

    _reset_movie_metadata_cache()
    try:
        rec = _MetadataRecorder()
        graph = _metadata_graph(rec)

        await _add_through_chain(graph, "meta-scope-1")
        before = rec.collection_calls
        await _add_through_chain(graph, "meta-scope-2")

        assert rec.collection_calls > before, "a user-scoped read was cached across members"
    finally:
        _reset_movie_metadata_cache()


# ── 047 US3 (T051): progress reaches the AG-UI wire ──────────────────────────────────────────────


async def test_import_progress_emits_state_snapshots_on_the_wire() -> None:
    """Progress must arrive as STATE_SNAPSHOT events, not just as state at the end.

    Drives the real AG-UI HTTP endpoint, because both failure modes are invisible below it: a
    counter not declared on GraphState is dropped silently (RQ-2), and super-step snapshots alone
    would emit nothing until the whole apply finished.
    """
    import json
    import uuid as _uuid

    from fastapi.testclient import TestClient

    from src.gateway import AGENT_PATH, build_app
    from src.graph import build_graph
    from src.proposals import (
        CollectionRef,
        Operation,
        Proposal,
        ProposalItem,
        ProposalKind,
    )
    from src.runtime_nodes import build_runtime_nodes

    n = 120
    proposal = Proposal(
        proposal_id="import:wire",
        kind=ProposalKind.batch,
        items=[
            ProposalItem(
                item_id=f"row-{i}",
                operation=Operation.add,
                movie_payload={"title": f"Film {i}", "year": 2000},
                idempotency_key=f"key:row-{i}",
            )
            for i in range(n)
        ],
        target_collection=CollectionRef(collection_id="0123456789abcdef01234567", name="Sci-Fi"),
        import_summary={"tabs": [], "totalCreate": n, "totalUpdate": 0, "skipped": []},
    )

    rec = _Recorder()
    nodes = build_runtime_nodes(_cfg(rec))
    nodes["import_collection"] = lambda _s: {"pending_proposal": proposal}
    graph = build_graph(classifier=lambda _m: "import", checkpointer=MemorySaver(), **nodes)

    client = TestClient(build_app(graph))
    thread = f"progress-{_uuid.uuid4().hex[:8]}"

    def _events(body: dict[str, Any]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        with client.stream("POST", AGENT_PATH, json=body) as resp:
            for line in resp.iter_lines():
                if line and line.startswith("data:"):
                    try:
                        out.append(json.loads(line[5:].strip()))
                    except json.JSONDecodeError:
                        pass
        return out

    base: dict[str, Any] = {
        "threadId": thread, "state": {}, "tools": [], "context": [], "forwardedProps": {},
    }
    _events({**base, "runId": "r1",
             "messages": [{"id": "m1", "role": "user", "content": "import"}]})
    resumed = _events({
        **base,
        "runId": "r2",
        "messages": [{"id": "m2", "role": "user", "content": "yes"}],
        "forwardedProps": {"command": {"resume": {"decision": "approved"}}},
    })

    progress = [
        e["snapshot"]["import_applied"]
        for e in resumed
        if e.get("type") == "STATE_SNAPSHOT" and "import_applied" in (e.get("snapshot") or {})
    ]
    assert progress, "no import progress reached the wire during a 120-item apply"

    # The wire carries the mid-run counters and THEN the reset: e.g.
    #   [25, 25, 50, 50, 75, 75, 100, 100, 120, 120, 120, 0]
    # Each value appears twice because `manually_emit_state` produces a snapshot and the
    # following super-step produces another (measured in RQ-2) — harmless, since a snapshot
    # REPLACES rather than accumulates. The trailing 0 is FR-014b: the run concluded, so the
    # progress surface is cleared and replaced by the report rather than left on its last number.
    assert progress[-1] == 0, (
        f"the progress surface was not cleared when the run finished (FR-014b): {progress}"
    )
    during = progress[:-1]
    assert during == sorted(during), f"progress went backwards mid-run: {during}"
    assert max(during) == n, f"progress never reached the total: max {max(during)} of {n}"
    assert len(progress) < n, "emitted one event per item — that is the flood FR-014a prevents"
