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

from src.nodes.import_disambiguation import CANCEL_IMPORT_LABEL
from src.runtime_nodes import RuntimeNodeConfig, build_runtime_graph
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.mcp_tools import McpCallResult
from src.tools.token_exchange import ExchangedToken
from tests.fixtures.adversarial import TRAILING_SPACE_TITLE

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


# ── 047 US2 (T025): the reported loop — a trailing-whitespace title ──────────────────────────
#
# "Three Billboards Outside Ebbing, Missouri " has an uncertain trailing comma-word, so the
# import asks how to sort it. The prompt used to key and label the option with the RAW cell
# value, trailing space included — making the label LONGER than the reply a tap posts back, so
# resolve_option's substring step could never match. Nothing resolved, nothing was recorded, and
# the same question re-fired on every turn: the member could never finish the import.
#
# Answered by TAP and by TYPING must both resolve, be recorded, and reach the approval gate.

_BILLBOARDS_PARSED = {
    "tabs": [
        {
            "name": "Favourites",  # exact collection match → no tab prompt, article prompt first
            "eligible": True,
            "columns": [{"header": "Title"}, {"header": "Year"}, {"header": "Video Type"}],
            "rowCount": 1,
            "rows": [
                {"Title": TRAILING_SPACE_TITLE, "Year": "2017", "Video Type": "Movie"},
            ],
        }
    ]
}


class _BillboardsRecorder(_Recorder):
    async def __call__(
        self, url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        if tool_name == "parse_spreadsheet":
            self.calls.append((tool_name, arguments, token))
            self.parse_count += 1
            return McpCallResult(False, _BILLBOARDS_PARSED, "")
        return await super().__call__(url, tool_name, arguments, token)


async def _billboards_turn_one(rec: _BillboardsRecorder, thread: str) -> Any:
    graph = _graph(rec)
    turn1 = await graph.ainvoke(
        {"messages": [("user", "import my movies from this spreadsheet")]}, _config(thread)
    )
    return graph, turn1


def _selection_labels(result: Any) -> set[str]:
    """Every render_selection label offered by the most recent assistant message."""
    for message in reversed(list(result.get("messages") or [])):
        calls = getattr(message, "tool_calls", None)
        if calls is None:
            continue
        return {
            o["label"]
            for c in calls
            if c["name"] == "render_selection"
            for o in c["args"]["options"]
        }
    return set()


def _still_asking(result: Any) -> bool:
    """True when the turn ended still waiting on the SAME import question.

    Message history is the wrong signal here — it accumulates, so turn 1's question is
    still the most recent assistant message even after turn 2 resolves the pick and goes
    straight to the approval gate. `import_stage` is the state the node actually branches
    on, so it is what distinguishes "re-asked" from "resolved".
    """
    return str(result.get("import_stage") or "") == "awaiting_import_choice"


async def test_three_billboards_asks_the_sorting_question_with_trimmed_labels() -> None:
    rec = _BillboardsRecorder()
    _graph_, turn1 = await _billboards_turn_one(rec, "bb-ask")
    labels = _selection_labels(turn1)
    assert labels, "no sorting question was asked at all"
    assert TRAILING_SPACE_TITLE.strip() in labels
    for label in labels:
        assert label == label.strip(), f"option label {label!r} carries whitespace"


async def test_three_billboards_resolves_when_answered_by_tap() -> None:
    """The tapped label posts back the trimmed title — it must resolve, not re-ask."""
    rec = _BillboardsRecorder()
    graph, _turn1 = await _billboards_turn_one(rec, "bb-tap")
    turn2 = await graph.ainvoke(
        {"messages": [("user", TRAILING_SPACE_TITLE.strip())]}, _config_no_handle("bb-tap")
    )
    assert not _still_asking(turn2), "the same question was re-issued — the loop is still live"
    assert "__interrupt__" in turn2, "the resolved pick must reach the approval gate"
    assert turn2["__interrupt__"][0].value["type"] == "import_preview"


async def test_three_billboards_resolves_when_answered_by_typing() -> None:
    """FR-036-style equivalence: typing the title (different case/spacing) resolves identically."""
    rec = _BillboardsRecorder()
    graph, _turn1 = await _billboards_turn_one(rec, "bb-type")
    typed = "  " + TRAILING_SPACE_TITLE.strip().lower() + "  "
    turn2 = await graph.ainvoke({"messages": [("user", typed)]}, _config_no_handle("bb-type"))
    assert not _still_asking(turn2), "the same question was re-issued — the loop is still live"
    assert "__interrupt__" in turn2, "the typed answer must reach the approval gate"


async def test_three_billboards_stores_a_trimmed_title_on_approval() -> None:
    """FR-011: the applied movie carries no surrounding whitespace in its title."""
    rec = _BillboardsRecorder()
    graph, _turn1 = await _billboards_turn_one(rec, "bb-write")
    await graph.ainvoke(
        {"messages": [("user", TRAILING_SPACE_TITLE.strip())]}, _config_no_handle("bb-write")
    )
    await graph.ainvoke(Command(resume={"decision": "approved"}), _config_no_handle("bb-write"))
    adds = [a for (n, a, _t) in rec.calls if n == "add_movie"]
    assert len(adds) == 1, f"expected exactly one add_movie, got {len(adds)}"
    title = adds[0]["movie"]["title"]
    assert title == title.strip(), f"stored title {title!r} carries whitespace"
    assert title == TRAILING_SPACE_TITLE.strip()


# ── 047 US2 (T035/T036): a reply that resolves nothing must not loop forever ─────────────────
#
# Before 047 the node re-emitted the byte-identical prompt with no counter and no escape, so a
# member whose answer never matched had no way out short of abandoning the conversation.
#
# Threshold note: spec.md FR-009 / US2-AC4 require the abandon control on the re-ask after ANY
# non-matching reply, so it appears from the FIRST miss. FR-010's "not a third time without the
# escape" is then satisfied a fortiori. plan.md/tasks.md said "after two"; see the comment on
# UNRESOLVED_REPLY_ESCAPE_THRESHOLD for why the stricter reading was taken.


def _cancel_labels(result: Any) -> set[str]:
    return {label for label in _selection_labels(result)}


async def test_escape_after_two_unresolved_replies_offers_a_way_out() -> None:
    rec = _Recorder()
    graph = _graph(rec)
    thread = "esc-1"
    await graph.ainvoke({"messages": [("user", "import my movies")]}, _config(thread))

    # Miss 1 — the re-ask already carries the escape (FR-009 / AC4).
    turn2 = await graph.ainvoke(
        {"messages": [("user", "absolutely not a collection")]}, _config_no_handle(thread)
    )
    assert _still_asking(turn2), "the question should still be pending after a miss"
    assert CANCEL_IMPORT_LABEL in _cancel_labels(turn2)
    assert turn2["import_unresolved_replies"] == 1
    assert "didn't understand" in str(turn2["messages"][-1].content)

    # Miss 2 — FR-010: still present, and the count has risen.
    turn3 = await graph.ainvoke(
        {"messages": [("user", "still nothing like an option")]}, _config_no_handle(thread)
    )
    assert CANCEL_IMPORT_LABEL in _cancel_labels(turn3)
    assert turn3["import_unresolved_replies"] == 2

    # The real options are never dropped in favour of the escape.
    assert {"Favourites", "Sci-Fi"} <= _cancel_labels(turn3)


async def test_escape_after_two_then_cancelling_ends_the_import_without_writing() -> None:
    rec = _Recorder()
    graph = _graph(rec)
    thread = "esc-2"
    await graph.ainvoke({"messages": [("user", "import my movies")]}, _config(thread))
    await graph.ainvoke({"messages": [("user", "gibberish")]}, _config_no_handle(thread))
    await graph.ainvoke({"messages": [("user", "more gibberish")]}, _config_no_handle(thread))

    final = await graph.ainvoke(
        {"messages": [("user", CANCEL_IMPORT_LABEL)]}, _config_no_handle(thread)
    )
    assert not _still_asking(final), "cancelling must end the import, not re-ask"
    assert "__interrupt__" not in final, "cancelling must not reach the approval gate"
    assert [n for (n, _a, _t) in rec.calls if n in ("add_movie", "update_movie")] == []
    assert "stopped the import" in str(final["messages"][-1].content)


async def test_escape_after_two_accepts_a_typed_cancel() -> None:
    """The escape must work typed as well as tapped — it is the way out of a stuck state."""
    rec = _Recorder()
    graph = _graph(rec)
    thread = "esc-3"
    await graph.ainvoke({"messages": [("user", "import my movies")]}, _config(thread))
    final = await graph.ainvoke(
        {"messages": [("user", "  never mind  ")]}, _config_no_handle(thread)
    )
    assert not _still_asking(final)
    assert [n for (n, _a, _t) in rec.calls if n in ("add_movie", "update_movie")] == []


async def test_escape_after_two_counter_resets_when_a_pick_resolves() -> None:
    """The threshold counts CONSECUTIVE misses — a good answer clears the slate."""
    rec = _BillboardsRecorder()
    graph = _graph(rec)
    thread = "esc-4"
    await graph.ainvoke({"messages": [("user", "import my movies")]}, _config(thread))
    miss = await graph.ainvoke({"messages": [("user", "nonsense")]}, _config_no_handle(thread))
    assert miss["import_unresolved_replies"] == 1
    resolved = await graph.ainvoke(
        {"messages": [("user", TRAILING_SPACE_TITLE.strip())]}, _config_no_handle(thread)
    )
    # The Billboards sheet has exactly one question, so resolving it finalizes the import.
    assert "__interrupt__" in resolved
    assert int(resolved.get("import_unresolved_replies") or 0) == 0


async def test_decisions_remaining_is_shown_in_the_asked_question() -> None:
    """FR-008: the member can see how many decisions are still outstanding."""
    rec = _MultiQuestionRecorder()
    graph = _graph(rec)
    turn1 = await graph.ainvoke(
        {"messages": [("user", "import my movies")]}, _config("remaining-1")
    )
    content = str(turn1["messages"][-1].content)
    assert "decisions left" in content, f"no remaining count in {content!r}"
    assert turn1["import_decisions_remaining"] >= 2


_MULTI_QUESTION_PARSED = {
    "tabs": [
        {
            "name": "Favourites",
            "eligible": True,
            "columns": [{"header": "Title"}, {"header": "Year"}, {"header": "Video Type"}],
            "rowCount": 3,
            "rows": [
                {"Title": "Goodbye, Lenin!", "Year": "2003", "Video Type": "Movie"},
                {"Title": "Amelie, Le", "Year": "2001", "Video Type": "Movie"},
                {"Title": TRAILING_SPACE_TITLE, "Year": "2017", "Video Type": "Movie"},
            ],
        }
    ]
}


class _MultiQuestionRecorder(_Recorder):
    """A sheet with three ambiguous titles → three questions, so FR-008's count is visible."""

    async def __call__(
        self, url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        if tool_name == "parse_spreadsheet":
            self.calls.append((tool_name, arguments, token))
            self.parse_count += 1
            return McpCallResult(False, _MULTI_QUESTION_PARSED, "")
        return await super().__call__(url, tool_name, arguments, token)
