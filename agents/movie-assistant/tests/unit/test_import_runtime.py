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


async def test_import_turn_pauses_at_a_summary_preview() -> None:
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
    # 014 UX fix: an import previews as a single tab-level SUMMARY (not a per-item wall of cards).
    assert payload["type"] == "import_preview"
    assert "items" not in payload
    assert payload["summary"]["tabs"][0]["tabName"] == "Sci-Fi"
    assert payload["summary"]["totalCreate"] == 1
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


async def test_missing_file_handle_asks_for_a_file_with_buttons() -> None:
    rec = _ImportRecorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "import", checkpointer=MemorySaver(),
        force=True,
    )
    config = {"configurable": {"thread_id": "imp-nofile", "subject_token": "s", "user_id": "u"}}
    result = await graph.ainvoke({"messages": [("user", "import movies")]}, config)
    assert "__interrupt__" not in result
    last = result["messages"][-1]
    assert "choose the spreadsheet" in str(last.content).lower()
    # 014 UX fix: the no-file branch emits a request_import_file affordance (Choose file / Cancel)
    # so an import can be started by TYPING (no always-on upload button).
    assert any(tc["name"] == "request_import_file" for tc in (last.tool_calls or []))
    assert rec.calls == []  # no parse/read attempted without a handle


class _MultiRowRecorder(_ImportRecorder):
    """Parses three eligible rows so we can prove a SINGLE confirm applies them all."""

    async def __call__(
        self, url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        if tool_name == "parse_spreadsheet":
            self.calls.append((tool_name, arguments, token))
            return McpCallResult(
                False,
                {
                    "tabs": [
                        {
                            "name": "Sci-Fi",
                            "eligible": True,
                            "columns": [
                                {"header": "Title", "sampleValues": []},
                                {"header": "Year", "sampleValues": []},
                                {"header": "Video Type", "sampleValues": []},
                            ],
                            "rowCount": 3,
                            "rows": [
                                {"Title": "Dune", "Year": "2021", "Video Type": "Movie"},
                                {"Title": "Arrival", "Year": "2016", "Video Type": "Movie"},
                                {"Title": "Alien", "Year": "1979", "Video Type": "Movie"},
                            ],
                        }
                    ]
                },
                "",
            )
        return await super().__call__(url, tool_name, arguments, token)


async def test_one_approval_applies_every_row_no_extra_prompts() -> None:
    rec = _MultiRowRecorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "import", checkpointer=MemorySaver(),
        force=True,
    )
    cfg = _config("imp-multi")
    paused = await graph.ainvoke({"messages": [("user", "import these movies")]}, cfg)
    assert paused["__interrupt__"][0].value["type"] == "import_preview"
    # A single approval applies ALL rows — no further interrupt, no per-batch re-prompt.
    final = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)
    assert "__interrupt__" not in final
    adds = [args["movie"]["title"] for (n, args, _t) in rec.calls if n == "add_movie"]
    assert sorted(adds) == ["Alien", "Arrival", "Dune"]


class _ManyRowRecorder(_ImportRecorder):
    """Parses `row_count` eligible rows — to prove an approved import larger than the per-agent
    rate-limit cap still applies EVERY row (the apply path is exempt from the limiter)."""

    def __init__(self, row_count: int) -> None:
        super().__init__()
        self.row_count = row_count

    async def __call__(
        self, url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        if tool_name == "parse_spreadsheet":
            self.calls.append((tool_name, arguments, token))
            rows = [
                {"Title": f"Movie {n}", "Year": str(2000 + n), "Video Type": "Movie"}
                for n in range(self.row_count)
            ]
            return McpCallResult(
                False,
                {
                    "tabs": [
                        {
                            "name": "Sci-Fi",
                            "eligible": True,
                            "columns": [
                                {"header": "Title", "sampleValues": []},
                                {"header": "Year", "sampleValues": []},
                                {"header": "Video Type", "sampleValues": []},
                            ],
                            "rowCount": self.row_count,
                            "rows": rows,
                        }
                    ]
                },
                "",
            )
        return await super().__call__(url, tool_name, arguments, token)


async def test_large_approved_import_is_not_throttled_by_the_rate_limiter() -> None:
    """Regression (014): a 200-row import was capped at 30 by the per-agent tool-call limiter,
    failing the other 170. The HITL-approved apply is exempt — every approved write lands even
    when the count far exceeds the limiter cap."""
    rows = 8
    rec = _ManyRowRecorder(rows)
    cfg = _cfg(rec)
    # A TIGHT cap (5) that the 8-row import would breach if the apply were throttled.
    cfg.limiter = AgentToolRateLimiter(max_calls=5, window_seconds=60)
    graph = build_runtime_graph(
        {}, config=cfg, classifier=lambda _m: "import", checkpointer=MemorySaver(), force=True,
    )
    config = _config("imp-many")
    await graph.ainvoke({"messages": [("user", "import these movies")]}, config)
    final = await graph.ainvoke(Command(resume={"decision": "approved"}), config)
    assert "__interrupt__" not in final
    adds = [n for (n, _a, _t) in rec.calls if n == "add_movie"]
    assert len(adds) == rows  # ALL rows applied despite the cap-5 limiter


async def test_excluding_a_tab_at_preview_writes_nothing() -> None:
    rec = _MultiRowRecorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "import", checkpointer=MemorySaver(),
        force=True,
    )
    cfg = _config("imp-exclude")
    await graph.ainvoke({"messages": [("user", "import these movies")]}, cfg)
    await graph.ainvoke(Command(resume={"decision": "approved", "excludedTabs": ["Sci-Fi"]}), cfg)
    assert [n for (n, _a, _t) in rec.calls if n == "add_movie"] == []
