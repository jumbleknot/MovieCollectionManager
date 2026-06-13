"""T051/T053/T055 (runtime): import node drives multi-turn disambiguation via the compiled graph.

When a tab can't be confidently resolved, turn 1 parses + persists the import context and asks
(buttons) WITHOUT writing or re-parsing (the file handle is single-use). A button-tap turn resolves
the pick in pure code, then either asks the next question or, once everything is resolved, builds
the proposal and pauses at the shared approval gate. Deterministic — injected transport, no
Keycloak/MCP/mc-service (the live path is T056).
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

# A tab whose name matches NO collection → forces the tab→collection prompt.
_PARSED = {
    "tabs": [
        {
            "name": "My Movies",
            "eligible": True,
            "columns": [
                {"header": "Title"},
                {"header": "Year"},
                {"header": "Video Type"},
            ],
            "rowCount": 1,
            "rows": [{"Title": "Dune", "Year": "2021", "Video Type": "Movie"}],
        }
    ]
}
_COLLECTIONS = [
    {"collectionId": "c-fav", "name": "Favourites"},
    {"collectionId": "c-scifi", "name": "Sci-Fi"},
]
_DOWNSCOPED = "downscoped-mc-token"


class _Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], str | None]] = []
        self.parse_count = 0

    async def __call__(
        self, url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        self.calls.append((tool_name, arguments, token))
        if tool_name == "parse_spreadsheet":
            self.parse_count += 1
            return McpCallResult(False, _PARSED, "")
        if tool_name == "list_collections":
            return McpCallResult(False, _COLLECTIONS, "")
        if tool_name == "list_movies":
            return McpCallResult(False, {"items": [], "nextCursor": None}, "")
        if tool_name in ("add_movie", "update_movie"):
            return McpCallResult(False, {"movieId": "m1", "collectionId": "c-fav"}, "")
        return McpCallResult(True, None, "unknown tool")


def _cfg(call: Any) -> RuntimeNodeConfig:
    async def authorize(_u: str, _a: str) -> bool:
        return True

    async def exchange(_s: str) -> ExchangedToken:
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


def _graph(rec: _Recorder) -> Any:
    return build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "import", checkpointer=MemorySaver(),
        force=True,
    )


async def test_unmatched_tab_asks_before_writing() -> None:
    rec = _Recorder()
    result = await _graph(rec).ainvoke(
        {"messages": [("user", "import my movies from this spreadsheet")]}, _config("dis-1")
    )
    assert "__interrupt__" not in result  # nothing to approve yet
    last = result["messages"][-1]
    picks = [c for c in (last.tool_calls or []) if c["name"] == "render_selection"]
    assert len(picks) == 1
    offered = {o["label"] for o in picks[0]["args"]["options"]}
    assert {"Favourites", "Sci-Fi"} <= offered
    # No write before resolution.
    assert [n for (n, _a, _t) in rec.calls if n in ("add_movie", "update_movie")] == []


async def test_pick_resolves_then_pauses_at_approval_without_reparsing() -> None:
    rec = _Recorder()
    graph = _graph(rec)
    cfg = _config("dis-2")
    await graph.ainvoke({"messages": [("user", "import these movies")]}, cfg)
    result = await graph.ainvoke({"messages": [("user", "Favourites")]}, cfg)
    # The pick turn must NOT re-parse the single-use handle.
    assert rec.parse_count == 1
    assert "__interrupt__" in result
    payload = result["__interrupt__"][0].value
    assert payload["type"] == "approval_request"
    assert any(item["operation"] == "add" for item in payload["items"])


async def test_pick_then_approve_writes_into_the_chosen_collection() -> None:
    rec = _Recorder()
    graph = _graph(rec)
    cfg = _config("dis-3")
    await graph.ainvoke({"messages": [("user", "import these")]}, cfg)
    await graph.ainvoke({"messages": [("user", "Favourites")]}, cfg)
    await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)
    adds = [(a, t) for (n, a, t) in rec.calls if n == "add_movie"]
    assert len(adds) == 1
    args, tok = adds[0]
    assert args["collectionId"] == "c-fav"
    assert args["movie"]["title"] == "Dune"
    assert tok == _DOWNSCOPED
