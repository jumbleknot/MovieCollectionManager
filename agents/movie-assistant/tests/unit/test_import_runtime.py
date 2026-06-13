"""T034 (runtime wiring): the import node drives the compiled graph through the HITL gate.

Exercises the COMPILED runtime graph (build_runtime_graph force=True) with injected transport:
an `import` turn parses the uploaded file (by handle, token-free spreadsheet-mcp), reads the
user's collections/movies (downscoped movie-mcp token), builds a proposal, and pauses at the
shared approval gate. Reject writes NOTHING (SC-009/FR-020); approve applies via add_movie with
the idempotency key. Deterministic — no Keycloak/MCP/mc-service (live path is T038).
"""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src.runtime_nodes import RuntimeNodeConfig, build_runtime_graph
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.mcp_tools import McpCallResult
from src.tools.token_exchange import ExchangedToken

_PARSED_TABS = {
    "tabs": [
        {
            "name": "Sci-Fi",
            "eligible": True,
            "columns": [
                {"header": "Title", "sampleValues": []},
                {"header": "Year", "sampleValues": []},
                {"header": "Video Type", "sampleValues": []},
            ],
            "rowCount": 1,
            "rows": [{"Title": "Dune", "Year": "2021", "Video Type": "Movie"}],
        }
    ]
}
_COLLECTIONS = [{"collectionId": "c-scifi", "name": "Sci-Fi"}]
_DOWNSCOPED = "downscoped-mc-token"


class _ImportRecorder:
    """Fake ToolCallFn returning canned results for the import flow; records (tool, args, token)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], str | None]] = []

    async def __call__(
        self, url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        self.calls.append((tool_name, arguments, token))
        if tool_name == "parse_spreadsheet":
            return McpCallResult(False, _PARSED_TABS, "")
        if tool_name == "list_collections":
            return McpCallResult(False, _COLLECTIONS, "")
        if tool_name == "list_movies":
            return McpCallResult(False, {"items": [], "nextCursor": None}, "")
        if tool_name in ("add_movie", "update_movie"):
            return McpCallResult(False, {"movieId": "m1", "collectionId": "c-scifi"}, "")
        return McpCallResult(True, None, "unknown tool")


def _cfg(call: Any) -> RuntimeNodeConfig:
    async def authorize(_user: str, _aud: str) -> bool:
        return True

    async def exchange(_subject: str) -> ExchangedToken:
        return ExchangedToken(token=_DOWNSCOPED, expires_in=60)

    return RuntimeNodeConfig(
        web_api_mcp_url="http://web-api-mcp/mcp",
        movie_mcp_url="http://movie-mcp/mcp",
        spreadsheet_mcp_url="http://spreadsheet-mcp/mcp",
        limiter=AgentToolRateLimiter(max_calls=100, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call,
    )


def _config(thread: str) -> dict[str, Any]:
    return {
        "configurable": {
            "thread_id": thread,
            "subject_token": "subj-123",
            "user_id": "user-1",
            "file_handle": "h-upload-1",
            "filename": "movies.xlsx",
        }
    }


async def test_import_turn_pauses_at_approval_with_a_proposal() -> None:
    rec = _ImportRecorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "import", checkpointer=MemorySaver(),
        force=True,
    )
    result = await graph.ainvoke(
        {"messages": [("user", "import my movies from this spreadsheet")]}, _config("imp-pause")
    )
    assert "__interrupt__" in result
    payload = result["__interrupt__"][0].value
    assert payload["type"] == "approval_request"
    assert any(item["operation"] == "add" for item in payload["items"])
    # parse_spreadsheet is token-free; movie-mcp reads carry the downscoped token.
    parse_tokens = [t for (n, _a, t) in rec.calls if n == "parse_spreadsheet"]
    assert parse_tokens == [None]
    assert [t for (n, _a, t) in rec.calls if n == "list_collections"] == [_DOWNSCOPED]
    # No write happens before approval.
    assert [n for (n, _a, _t) in rec.calls if n in ("add_movie", "update_movie")] == []


async def test_reject_writes_nothing() -> None:
    rec = _ImportRecorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "import", checkpointer=MemorySaver(),
        force=True,
    )
    cfg = _config("imp-reject")
    await graph.ainvoke({"messages": [("user", "import these movies")]}, cfg)
    await graph.ainvoke(Command(resume={"decision": "rejected"}), cfg)
    assert [n for (n, _a, _t) in rec.calls if n in ("add_movie", "update_movie")] == []


async def test_approve_applies_the_create_with_idempotency_key() -> None:
    rec = _ImportRecorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "import", checkpointer=MemorySaver(),
        force=True,
    )
    cfg = _config("imp-approve")
    await graph.ainvoke({"messages": [("user", "import these movies")]}, cfg)
    await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)

    adds = [(args, tok) for (n, args, tok) in rec.calls if n == "add_movie"]
    assert len(adds) == 1
    args, tok = adds[0]
    assert args["collectionId"] == "c-scifi"
    assert args["movie"]["title"] == "Dune"
    assert args["idempotencyKey"]  # at-most-once key forwarded
    assert tok == _DOWNSCOPED  # write carries the downscoped token


async def test_missing_file_handle_asks_for_a_file() -> None:
    rec = _ImportRecorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "import", checkpointer=MemorySaver(),
        force=True,
    )
    config = {"configurable": {"thread_id": "imp-nofile", "subject_token": "s", "user_id": "u"}}
    result = await graph.ainvoke({"messages": [("user", "import movies")]}, config)
    assert "__interrupt__" not in result
    assert "attach a spreadsheet" in str(result["messages"][-1].content).lower()
    assert rec.calls == []  # no parse/read attempted without a handle
