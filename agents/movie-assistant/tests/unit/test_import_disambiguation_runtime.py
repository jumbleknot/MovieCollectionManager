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
    assert payload["type"] == "import_preview"
    assert payload["summary"]["totalCreate"] >= 1


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


# ── Live-faithful reproduction (T056): the two facts the tests above did not model ──────────
#   1. The button-tap turn carries NO file_handle (the BFF clears the per-user import-file ref
#      after turn 1 — it is single-use). _config() above passes a handle on EVERY turn, hiding
#      the fresh-branch fall-through.
#   2. A live classifier reads a bare collection-name button ("Favourites") as out_of_domain, NOT
#      import. The `lambda _m: "import"` above masks whether the supervisor's import_stage gate
#      actually keeps the turn in the import node.


def _last_human(messages: Any) -> str:
    for message in reversed(list(messages or [])):
        if getattr(message, "type", None) == "human":
            return str(getattr(message, "content", "") or "")
        if isinstance(message, (list, tuple)) and len(message) == 2 and message[0] == "user":
            return str(message[1] or "")
    return ""


def _realistic_classifier(messages: Any) -> str:
    """Only an explicit import request reads as `import`; a bare button label does not."""
    return "import" if "import" in _last_human(messages).lower() else "out_of_domain"


def _config_no_handle(thread: str) -> dict[str, Any]:
    """Turn-2 config as the live BFF sends it: same thread, single-use handle already cleared."""
    return {
        "configurable": {
            "thread_id": thread,
            "subject_token": "subj-123",
            "user_id": "user-1",
        }
    }


async def test_live_faithful_pick_finalizes_without_reparse_or_handle() -> None:
    rec = _Recorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=_realistic_classifier, checkpointer=MemorySaver(),
        force=True,
    )
    thread = "dis-live"

    turn1 = await graph.ainvoke(
        {"messages": [("user", "import my movies from this spreadsheet")]}, _config(thread)
    )
    assert "__interrupt__" not in turn1
    assert rec.parse_count == 1

    # Button tap: same thread, NO file_handle, classifier says out_of_domain.
    turn2 = await graph.ainvoke({"messages": [("user", "Favourites")]}, _config_no_handle(thread))
    assert rec.parse_count == 1, "turn 2 must NOT re-parse the single-use handle"
    assert "__interrupt__" in turn2, "the resolved pick must reach the approval gate"
    payload = turn2["__interrupt__"][0].value
    assert payload["type"] == "import_preview"
    assert payload["summary"]["totalCreate"] >= 1

    await graph.ainvoke(Command(resume={"decision": "approved"}), _config_no_handle(thread))
    adds = [a for (n, a, _t) in rec.calls if n == "add_movie"]
    assert len(adds) == 1
    assert adds[0]["collectionId"] == "c-fav"


# ── 040 US2: import reliability (never a silent stop; dedup reads not throttled) ─────────────


class _ParseCrashRecorder(_Recorder):
    """Raises a non-transient error on parse — simulates an unexpected import failure."""

    async def __call__(
        self, url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        if tool_name == "parse_spreadsheet":
            raise ValueError("simulated parse crash")
        return await super().__call__(url, tool_name, arguments, token)


async def test_import_node_error_surfaces_message_not_silent_stop() -> None:
    # 040 US2 / FR-014: a non-transient failure inside the import node degrades to a VISIBLE
    # "import failed" message — never ends the run with a blank/no reply ("it just stopped").
    rec = _ParseCrashRecorder()
    graph = build_runtime_graph(
        {}, config=_cfg(rec), classifier=lambda _m: "import", checkpointer=MemorySaver(),
        force=True,
    )
    result = await graph.ainvoke(
        {"messages": [("user", "import my movies")]}, _config("import-err-1")
    )
    text = str(result["messages"][-1].content).lower()
    assert "import failed" in text  # visible outcome, not a silent stop


async def test_import_dedup_reads_are_not_rate_limited() -> None:
    # 040 US2 / FR-015: under a tight limiter (max_calls=1, consumed by parse_spreadsheet), the
    # code-orchestrated collection read must still execute (skip_rate_limit) — otherwise it is
    # throttled to an empty list and the tab→collection prompt would offer nothing (silently
    # partial dedup). Proof: the prompt still offers the user's real collections.
    from dataclasses import replace

    rec = _Recorder()
    cfg = replace(_cfg(rec), limiter=AgentToolRateLimiter(max_calls=1, window_seconds=60))
    graph = build_runtime_graph(
        {}, config=cfg, classifier=lambda _m: "import", checkpointer=MemorySaver(), force=True
    )
    result = await graph.ainvoke(
        {"messages": [("user", "import my movies")]}, _config("import-rl-1")
    )
    last = result["messages"][-1]
    picks = [c for c in (last.tool_calls or []) if c["name"] == "render_selection"]
    assert len(picks) == 1
    offered = {o["label"] for o in picks[0]["args"]["options"]}
    assert {"Favourites", "Sci-Fi"} <= offered  # list_collections executed despite max_calls=1
    assert "list_collections" in [n for (n, _a, _t) in rec.calls]
