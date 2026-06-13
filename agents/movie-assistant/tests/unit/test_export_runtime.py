"""T045 (runtime wiring): the export node drives the compiled graph to a download UI-action.

Exercises the COMPILED runtime graph (build_runtime_graph force=True) with injected transport:
an `export` turn reads the user's collections/movies (downscoped movie-mcp token), builds the
workbook via the token-free spreadsheet-mcp, and emits a `download_export` UI-action carrying the
transient handle. Read-only — no interrupt, no write tool. Deterministic (no Keycloak/MCP/
mc-service; the live path is T048).
"""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import MemorySaver

from src.runtime_nodes import RuntimeNodeConfig, build_runtime_graph
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.mcp_tools import McpCallResult
from src.tools.token_exchange import ExchangedToken

_COLLECTIONS = [
    {"collectionId": "c-scifi", "name": "Sci-Fi"},
    {"collectionId": "c-drama", "name": "Drama"},
]
_MOVIES = {
    "c-scifi": [{"movieId": "m1", "title": "Dune", "year": 2021, "contentType": "Movie",
                 "genres": ["Sci-Fi"], "owned": True}],
    "c-drama": [{"movieId": "m2", "title": "Drive", "year": 2011, "contentType": "Movie"}],
}
_DOWNSCOPED = "downscoped-mc-token"


class _ExportRecorder:
    """Fake ToolCallFn for the export flow; records (tool, args, token)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], str | None]] = []

    async def __call__(
        self, url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        self.calls.append((tool_name, arguments, token))
        if tool_name == "list_collections":
            return McpCallResult(False, _COLLECTIONS, "")
        if tool_name == "list_movies":
            cid = str(arguments.get("collectionId"))
            return McpCallResult(False, {"items": _MOVIES.get(cid, []), "nextCursor": None}, "")
        if tool_name == "build_workbook":
            return McpCallResult(
                False, {"downloadHandle": "dl-1", "filename": "movie-collections-export.xlsx"}, ""
            )
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


def _config(thread: str, ids: list[str] | None = None) -> dict[str, Any]:
    configurable: dict[str, Any] = {
        "thread_id": thread,
        "subject_token": "subj-123",
        "user_id": "user-1",
    }
    if ids is not None:
        configurable["export_collection_ids"] = ids
    return {"configurable": configurable}


def _graph(rec: _ExportRecorder) -> Any:
    return build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "export", checkpointer=MemorySaver(),
        force=True,
    )


async def test_export_emits_a_download_ui_action_no_writes() -> None:
    rec = _ExportRecorder()
    result = await _graph(rec).ainvoke(
        {"messages": [("user", "export my collections to a spreadsheet")]},
        _config("exp-1"),
    )
    assert "__interrupt__" not in result  # read-only, no HITL gate
    last = result["messages"][-1]
    actions = [c for c in (last.tool_calls or []) if c["name"] == "download_export"]
    assert len(actions) == 1
    assert actions[0]["args"]["handle"] == "dl-1"
    assert actions[0]["args"]["filename"].endswith(".xlsx")
    # No write tool was ever called.
    assert [n for (n, _a, _t) in rec.calls if n in ("add_movie", "update_movie")] == []


async def test_export_reads_carry_downscoped_token_build_is_token_free() -> None:
    rec = _ExportRecorder()
    await _graph(rec).ainvoke(
        {"messages": [("user", "export everything")]}, _config("exp-2")
    )
    assert [t for (n, _a, t) in rec.calls if n == "list_collections"] == [_DOWNSCOPED]
    # spreadsheet-mcp build is token-free.
    assert [t for (n, _a, t) in rec.calls if n == "build_workbook"] == [None]


async def test_export_default_exports_all_collections() -> None:
    rec = _ExportRecorder()
    await _graph(rec).ainvoke({"messages": [("user", "export")]}, _config("exp-3"))
    build_calls = [args for (n, args, _t) in rec.calls if n == "build_workbook"]
    assert len(build_calls) == 1
    tabs = build_calls[0]["tabs"]
    assert [t["collectionName"] for t in tabs] == ["Sci-Fi", "Drama"]


async def test_export_selected_subset_only() -> None:
    rec = _ExportRecorder()
    await _graph(rec).ainvoke(
        {"messages": [("user", "export")]}, _config("exp-4", ids=["c-drama"])
    )
    tabs = [args for (n, args, _t) in rec.calls if n == "build_workbook"][0]["tabs"]
    assert [t["collectionName"] for t in tabs] == ["Drama"]
    # Only the selected collection's movies were read.
    read = [a["collectionId"] for (n, a, _t) in rec.calls if n == "list_movies"]
    assert read == ["c-drama"]
