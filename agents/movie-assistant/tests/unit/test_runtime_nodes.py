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

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src.runtime_nodes import (
    RuntimeNodeConfig,
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


def test_production_nodes_enabled_requires_both_mcp_urls() -> None:
    assert production_nodes_enabled(
        {"WEB_API_MCP_URL": "http://w/mcp", "MOVIE_MCP_URL": "http://m/mcp"}
    )
    assert not production_nodes_enabled({"WEB_API_MCP_URL": "http://w/mcp"})
    assert not production_nodes_enabled({"MOVIE_MCP_URL": "http://m/mcp"})
    assert not production_nodes_enabled({})


def test_build_runtime_nodes_returns_the_three_specialist_nodes() -> None:
    nodes = build_runtime_nodes(_cfg(_Recorder()))
    assert set(nodes) == {"curator", "organizer", "approval_gate"}


async def test_factory_graph_pauses_at_approval_with_a_proposal() -> None:
    rec = _Recorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "add", checkpointer=MemorySaver(), force=True
    )
    result = await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        _config("rt-pause"),
    )
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
    final = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)

    assert final["status"] == "completed"
    result = final["apply_result"]
    assert result.skipped_item_ids  # the duplicate add is skipped, not failed
    assert not result.failed_item_ids
    assert "skipped" in final["messages"][-1].content.lower()
