"""FR-039 — a read that did not complete is never presented as though it had.

Every read closure in `runtime_nodes.py` used to collapse `ToolOutcome(ok=False)` into a value
indistinguishable from a truthful answer: a list became `[]`, a count became `0`, and a paginated
read `break`ed and returned a partial list as the whole. Each collapse is a claim about the
member's library the system is not entitled to make.

These drive the COMPILED runtime graph (`build_runtime_graph(..., force=True)`) with an injected
transport that fails a chosen tool, so BOTH halves are exercised: the closure raising
`ToolReadError` and the node catching it where the reply is composed. A node-level test would
prove neither — see the 047 PR A lesson in `docs/runbooks/agent-layer.md`.

Discovered by the RQ-1 investigation; see `specs/047-movie-assistant-enhancements/research.md`.
"""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import MemorySaver

from src.runtime_nodes import RuntimeNodeConfig, build_runtime_graph
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.mcp_tools import McpCallResult
from src.tools.token_exchange import ExchangedToken

GENERIC_DEGRADE = "Sorry — I couldn't complete that just now. Please try again."

_COLLECTIONS = [
    {"collectionId": "0123456789abcdef01234567", "name": "Sci-Fi", "movieCount": 2300},
    {"collectionId": "0123456789abcdef01234568", "name": "Favourites", "movieCount": 12},
]
_PAGE = [{"movieId": f"m{i}", "title": f"Film {i}", "year": 2000} for i in range(50)]


class _FailingTransport:
    """Succeeds at everything except `fail_tool`, which fails on the nth call (1-based).

    `fail_on=1` fails the read outright; `fail_on=2` fails the SECOND page of a paginated read,
    which is the truncation case — the one that produces a partial list rather than an empty one.
    """

    def __init__(self, fail_tool: str, *, fail_on: int = 1) -> None:
        self.fail_tool = fail_tool
        self.fail_on = fail_on
        self.seen: dict[str, int] = {}
        self.calls: list[str] = []

    async def __call__(
        self, _url: str, tool_name: str, arguments: dict[str, Any], _token: str | None
    ) -> McpCallResult:
        self.calls.append(tool_name)
        self.seen[tool_name] = self.seen.get(tool_name, 0) + 1
        if tool_name == self.fail_tool and self.seen[tool_name] >= self.fail_on:
            return McpCallResult(is_error=True, data=None, text="mc-service-status:503 upstream")
        if tool_name == "list_collections":
            return McpCallResult(False, _COLLECTIONS, "")
        if tool_name == "list_movies":
            # Two pages, so `fail_on=2` can truncate a read that already returned data.
            page = self.seen[tool_name]
            return McpCallResult(
                False, {"items": _PAGE, "nextCursor": "c2" if page < 2 else None}, ""
            )
        if tool_name == "count_movies":
            return McpCallResult(False, {"count": 2300}, "")
        if tool_name == "search_title":
            return McpCallResult(False, {"matchConfidence": "none", "results": []}, "")
        if tool_name == "get_movie_metadata":
            return McpCallResult(False, {"mediaFormats": ["DVD", "Blu-Ray"]}, "")
        return McpCallResult(True, None, f"unhandled tool {tool_name}")


def _cfg(call: Any, **seams: Any) -> RuntimeNodeConfig:
    async def authorize(_user: str, _aud: str) -> bool:
        return True

    async def exchange(_subject: str) -> ExchangedToken:
        return ExchangedToken(token="downscoped", expires_in=60)

    return RuntimeNodeConfig(
        web_api_mcp_url="http://web-api-mcp/mcp",
        movie_mcp_url="http://movie-mcp/mcp",
        spreadsheet_mcp_url="http://spreadsheet-mcp/mcp",
        limiter=AgentToolRateLimiter(max_calls=500, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call,
        # Every model-backed seam is stubbed. Leaving one on its real default makes it raise,
        # which degrades the turn BEFORE any read happens — a vacuously green test.
        extract=seams.get("extract", lambda _m: {"title": "The Matrix", "year": 1999}),
        plan=seams.get("plan", lambda _m: {"collection": "Sci-Fi", "operations": []}),
        query_extract=seams.get(
            "query_extract", lambda _m: {"collection_ref": "Sci-Fi", "filter": None}
        ),
    )


def _graph(call: Any, intent: str, **seams: Any) -> Any:
    return build_runtime_graph(
        {},
        config=_cfg(call, **seams),
        classifier=lambda _m: intent,
        checkpointer=MemorySaver(),
        force=True,
    )


def _conf(thread: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread, "subject_token": "s", "user_id": "u"}}


def _text(result: dict[str, Any]) -> str:
    msgs = result.get("messages") or []
    return str(getattr(msgs[-1], "content", "")) if msgs else ""


async def _run(call: Any, intent: str, message: str, thread: str, **kw: Any) -> dict[str, Any]:
    graph = _graph(call, intent, **kw)
    result = await graph.ainvoke({"messages": [("user", message)]}, _conf(thread))
    _assert_reached_the_failing_read(call)
    return result


def _assert_reached_the_failing_read(call: _FailingTransport) -> None:
    """Fail loudly when the turn never got as far as the read under test.

    Without this every test here is vacuously green: a mis-stubbed model seam raises inside the
    node, the turn degrades BEFORE any tool call, and an assertion like "the reply must not say
    0" passes against a reply that says nothing at all. Four of these tests did exactly that on
    first run. A test that did not exercise its subject is a failure, not a pass.
    """
    assert call.fail_tool in call.calls, (
        f"vacuous test: {call.fail_tool!r} was never called (tools reached: {call.calls}). "
        "The turn ended before the read — check the stubbed model seams and the intent."
    )
    assert call.seen.get(call.fail_tool, 0) >= call.fail_on, (
        f"vacuous test: {call.fail_tool!r} was called "
        f"{call.seen.get(call.fail_tool, 0)}x but the failure is armed at call {call.fail_on}"
    )


# ── the three member-visible symptoms, named ─────────────────────────────────────────────────────


async def test_navigator_unreadable_collections_is_not_an_empty_library() -> None:
    """The E2b symptom: asking "which collection?" while offering none says the library is empty."""
    call = _FailingTransport("list_collections")
    result = await _run(call, "navigate", "navigate to my Sci-Fi collection", "nav-1")

    reply = _text(result)
    assert reply, "a failed read must still answer the member"
    assert "Which collection would you like to open?" not in reply
    assert reply != GENERIC_DEGRADE, "a failed READ must not read as a failed model call"


async def test_query_unreadable_count_is_not_zero() -> None:
    """"How many movies do I have?" must never be answered "0" from a failed read."""
    call = _FailingTransport("count_movies")
    result = await _run(
        call, "query", "how many movies do I have", "q-1",
        query_extract=lambda _m: {"collection_ref": "Sci-Fi", "filter": None},
    )

    reply = _text(result)
    assert "0" not in reply.replace("2300", ""), f"claimed a count from a failed read: {reply!r}"


async def test_export_does_not_write_a_truncated_file() -> None:
    """A failed page mid-pagination must not yield a spreadsheet that looks complete.

    §File-Processing Safety: "no partial result".
    """
    call = _FailingTransport("list_movies", fail_on=2)
    result = await _run(call, "export", "export my Sci-Fi collection", "x-1")

    assert "build_workbook" not in call.calls, (
        f"built a workbook from a truncated read (tools: {call.calls})"
    )
    assert _text(result), "a failed export must tell the member it failed"


async def test_organizer_unreadable_collections_does_not_claim_the_target_is_missing() -> None:
    call = _FailingTransport("list_collections")
    result = await _run(
        call, "organize", "move The Matrix to my Favourites", "o-1",
        plan=lambda _m: {
            "collection": "Favourites",
            "operations": [{"kind": "move", "title": "The Matrix"}],
        },
    )

    reply = _text(result).lower()
    assert "don't have" not in reply and "couldn't find" not in reply, (
        f"claimed the collection is absent from a failed read: {_text(result)!r}"
    )


async def test_search_unreadable_collections_does_not_claim_the_film_is_absent() -> None:
    call = _FailingTransport("list_collections")
    result = await _run(
        call, "search", "do I have The Matrix", "s-1",
        extract=lambda _m: {"title": "The Matrix", "year": None},
    )

    reply = _text(result).lower()
    for lie in ("not in your collection", "don't have", "couldn't find", "no results"):
        assert lie not in reply, (
            f"a failed read of the member's OWN collections became {lie!r} — an absence claim "
            f"the system cannot make: {_text(result)!r}"
        )


# ── negative controls: the paths a well-meaning sweep breaks (T108) ───────────────────────────────


async def test_excluded_movie_metadata_still_skips_rather_than_failing() -> None:
    """RQ-4's documented failure path: SKIP the media-format question, never guess — and never
    turn the whole add into a read failure. Converting this one would break intended behaviour."""
    call = _FailingTransport("get_movie_metadata")
    graph = _graph(call, "add", extract=lambda _m: {"title": "The Matrix", "year": 1999})
    result = await graph.ainvoke({"messages": [("user", "add The Matrix")]}, _conf("a-1"))

    reply = _text(result)
    assert "couldn't read" not in reply.lower(), (
        f"metadata failure must skip the question, not fail the add: {reply!r}"
    )
