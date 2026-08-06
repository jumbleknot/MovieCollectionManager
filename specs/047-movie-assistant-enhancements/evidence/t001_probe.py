"""T001 / RQ-1 probe — what can and cannot emit the generic reply for a NAVIGATE request.

Drives the COMPILED graph (build_graph), never a node directly, because the whole question is
about routing and guards. Five experiments:

  E1   model-call topology of a navigate turn     -> eliminates/keeps the specialist-model cause (H4)
  E2   large library + tool-call limiter breach   -> can the navigator itself degrade?
  E2b  a second navigate turn in the same window  -> the large-library symptom that IS real
  E3   supervisor model failure                   -> the degrade path, and what it does to the breaker
  E4   node-level failure x20                     -> can a downstream failure ever open the breaker?

Findings are written up in ../research.md#rq-1-evidence. Run (no stack needed):

    cd agents/movie-assistant && uv run --offline python \
      ../../specs/047-movie-assistant-enhancements/evidence/t001_probe.py
"""

from __future__ import annotations

import asyncio
from typing import Any

from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver

from src.circuit_breaker import ErrorRateBreaker
from src.graph import build_graph
from src.nodes.navigator import build_navigator
from src.tools.agent_rate_limit import AgentRateLimitExceeded, AgentToolRateLimiter

GENERIC = "Sorry — I couldn't complete that just now. Please try again."
OK = "\033[32mPASS\033[0m"
NO = "\033[31mFAIL\033[0m"

# A realistically large library: 40 collections, the target holding 2,300 movies at 50/page.
BIG_COLLECTIONS = [
    {"collectionId": f"c{i:03d}", "name": f"Collection {i:03d}", "movieCount": 12}
    for i in range(40)
]
BIG_COLLECTIONS[7] = {"collectionId": "c007", "name": "Huge Library", "movieCount": 2300}
PAGE = 50
PAGES_IN_TARGET = 2300 // PAGE  # 46 pages -> 46 list_movies calls for ONE collection


def _last_text(result: dict[str, Any]) -> str:
    msgs = result.get("messages") or []
    return str(getattr(msgs[-1], "content", "")) if msgs else ""


def _tool_names(result: dict[str, Any]) -> list[str]:
    msgs = result.get("messages") or []
    if not msgs:
        return []
    return [tc["name"] for tc in (getattr(msgs[-1], "tool_calls", None) or [])]


def _cfg(thread: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread}}


# ── E1: how many model calls does a navigate turn make, and to which tier? ───────────────────────


async def e1_model_call_topology() -> None:
    print("\n=== E1 — model-call topology of a navigate turn ===")
    calls: list[str] = []

    def classifier(_messages: Any) -> str:
        calls.append("supervisor")  # SUPERVISOR_MODEL
        return "navigate"

    def specialist_node(name: str) -> Any:
        # Stands in for curator/organizer/query, each of which builds a SPECIALIST_MODEL.
        def node(_state: dict[str, Any]) -> dict[str, Any]:
            calls.append(name)  # SPECIALIST_MODEL
            return {"messages": []}

        return node

    async def list_collections() -> list[dict[str, Any]]:
        return BIG_COLLECTIONS

    async def list_movies(_cid: str) -> list[dict[str, Any]]:
        return []

    graph = build_graph(
        classifier=classifier,
        curator=specialist_node("curator"),
        organizer=specialist_node("organizer"),
        query=specialist_node("query"),
        navigator=build_navigator(list_collections=list_collections, list_movies=list_movies),
        checkpointer=MemorySaver(),
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="navigate to my Huge Library collection")]},
        _cfg("e1"),
    )

    print(f"  model calls made : {calls}")
    print(f"  reply            : {_last_text(result)!r}")
    print(f"  tool calls       : {_tool_names(result)}")
    specialist_calls = [c for c in calls if c != "supervisor"]
    print(f"  {OK if calls == ['supervisor'] else NO} exactly one model call, the supervisor's")
    print(f"  {OK if not specialist_calls else NO} zero SPECIALIST_MODEL calls on this path")
    print(f"  {OK if _last_text(result) != GENERIC else NO} reply is not the generic message")


# ── E2: does a large library + a limiter breach degrade the navigator? ───────────────────────────


async def e2_large_library_limiter() -> None:
    print("\n=== E2 — 2,300-movie collection vs the 30-call/60 s agent limiter ===")
    limiter = AgentToolRateLimiter(max_calls=30, window_seconds=60.0)  # production defaults
    pages_served = {"n": 0}

    async def list_collections() -> list[dict[str, Any]]:
        # Mirrors runtime_nodes.py: a failed read returns [] rather than raising.
        try:
            limiter.check("navigator", "user-1")
        except AgentRateLimitExceeded:
            return []
        return BIG_COLLECTIONS

    async def list_movies(_cid: str) -> list[dict[str, Any]]:
        # Mirrors runtime_nodes.py:449-467 exactly: paginate, and BREAK (not raise) when a call
        # comes back not-ok — which is what the limiter breach produces via invoke_tool.
        items: list[dict[str, Any]] = []
        cursor: str | None = None
        for _ in range(200):
            try:
                limiter.check("navigator", "user-1")
            except AgentRateLimitExceeded:
                break  # invoke_tool returns ok=False here; the loop breaks with a PARTIAL list
            pages_served["n"] += 1
            page = [
                {"movieId": f"m{len(items) + i}", "title": f"Film {len(items) + i}", "year": 2000}
                for i in range(PAGE)
            ]
            items.extend(page)
            cursor = "next" if len(items) < 2300 else None
            if not cursor:
                break
        return items

    graph = build_graph(
        classifier=lambda _m: "navigate",
        navigator=build_navigator(list_collections=list_collections, list_movies=list_movies),
        checkpointer=MemorySaver(),
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="navigate to my Huge Library collection")]},
        _cfg("e2"),
    )

    print(f"  pages fetched before the limiter cut it off : {pages_served['n']} of {PAGES_IN_TARGET}")
    print(f"  reply      : {_last_text(result)!r}")
    print(f"  tool calls : {_tool_names(result)}")
    breached = pages_served["n"] < PAGES_IN_TARGET
    print(f"  {OK if breached else NO} the limiter DID breach mid-pagination (the real defect)")
    print(f"  {OK if _last_text(result) != GENERIC else NO} and the reply is STILL not the generic message")
    print(f"  {OK if 'navigate_to_collection' in _tool_names(result) else NO} navigation still succeeded")


# ── E3: the supervisor model fails ───────────────────────────────────────────────────────────────


async def e3_supervisor_failure() -> None:
    print("\n=== E3 — supervisor model raises (a 404 / unknown model id) ===")

    def raising_classifier(_messages: Any) -> str:
        raise RuntimeError("404 model 'qwen2.5:32b' not found")

    circuit = ErrorRateBreaker(threshold=0.5, window=20, cooldown_s=30, min_samples=5)
    graph = build_graph(
        classifier=raising_classifier,
        navigator=build_navigator(list_collections=lambda: _empty(), list_movies=None),
        circuit=circuit,
        checkpointer=MemorySaver(),
    )
    first = await graph.ainvoke(
        {"messages": [HumanMessage(content="navigate to my Huge Library collection")]},
        _cfg("e3-a"),
    )
    print(f"  turn 1 reply : {_last_text(first)!r}")
    print(f"  {OK if _last_text(first) == GENERIC else NO} a supervisor-model failure DOES emit the generic reply")
    print(f"  breaker after turn 1 : {circuit.state}")

    for i in range(2, 7):
        await graph.ainvoke(
            {"messages": [HumanMessage(content="navigate to my Huge Library collection")]},
            _cfg(f"e3-{i}"),
        )
    print(f"  breaker after 6 failed turns : {circuit.state}")
    print(f"  {OK if circuit.state == 'open' else NO} repeated classifier failure OPENS the breaker")

    # Now the provider recovers, but the breaker is still open within its 30 s cooldown.
    healthy = build_graph(
        classifier=lambda _m: "navigate",
        navigator=build_navigator(list_collections=lambda: _empty(), list_movies=None),
        circuit=circuit,
        checkpointer=MemorySaver(),
    )
    after = await healthy.ainvoke(
        {"messages": [HumanMessage(content="navigate to my Huge Library collection")]},
        _cfg("e3-recovered"),
    )
    print(f"  reply with a HEALTHY classifier but an open breaker : {_last_text(after)!r}")
    print(f"  {OK if _last_text(after) == GENERIC else NO} H1 and H3 are the same event, 30 s apart")


async def _empty() -> list[dict[str, Any]]:
    return []


# ── E4: can a downstream node failure ever open the breaker? ─────────────────────────────────────


async def e4_node_failure_never_trips_breaker() -> None:
    print("\n=== E4 — 20 turns where the SPECIALIST node degrades (a curator/query 404) ===")
    circuit = ErrorRateBreaker(threshold=0.5, window=20, cooldown_s=30, min_samples=5)

    def failing_specialist(_state: dict[str, Any]) -> dict[str, Any]:
        # Exactly what curator.py:152 / query.py:226 / organizer.py:857 do when their
        # SPECIALIST_MODEL call raises: catch it and reply, inside the node.
        from langchain_core.messages import AIMessage

        return {"messages": [AIMessage(content=GENERIC)]}

    graph = build_graph(
        classifier=lambda _m: "query",
        query=failing_specialist,
        circuit=circuit,
        checkpointer=MemorySaver(),
    )
    for i in range(20):
        result = await graph.ainvoke(
            {"messages": [HumanMessage(content="how many movies do I have")]}, _cfg(f"e4-{i}")
        )
    print(f"  turn 20 reply : {_last_text(result)!r}")
    print(f"  breaker after 20 consecutive degraded turns : {circuit.state}")
    print(f"  {OK if circuit.state == 'closed' else NO} a node-level failure NEVER feeds the breaker")


async def e2b_second_turn_in_the_same_window() -> None:
    print("\n=== E2b — a SECOND navigate turn inside the same 60 s window ===")
    limiter = AgentToolRateLimiter(max_calls=30, window_seconds=60.0)

    async def list_collections() -> list[dict[str, Any]]:
        try:
            limiter.check("navigator", "user-1")
        except AgentRateLimitExceeded:
            return []  # runtime_nodes.py:445 — a failed read is an EMPTY read
        return BIG_COLLECTIONS

    async def list_movies(_cid: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for _ in range(200):
            try:
                limiter.check("navigator", "user-1")
            except AgentRateLimitExceeded:
                break
            items.extend([{"movieId": f"m{len(items)}", "title": f"Film {len(items)}"}] * PAGE)
            if len(items) >= 2300:
                break
        return items

    graph = build_graph(
        classifier=lambda _m: "navigate",
        navigator=build_navigator(list_collections=list_collections, list_movies=list_movies),
        checkpointer=MemorySaver(),
    )
    msg = "navigate to my Huge Library collection"
    first = await graph.ainvoke({"messages": [HumanMessage(content=msg)]}, _cfg("e2b-1"))
    second = await graph.ainvoke({"messages": [HumanMessage(content=msg)]}, _cfg("e2b-2"))

    print(f"  turn 1 : {_last_text(first)!r}  tools={_tool_names(first)}")
    print(f"  turn 2 : {_last_text(second)!r}  tools={_tool_names(second)}")
    t2 = _last_text(second)
    print(f"  {OK if t2 != GENERIC else NO} turn 2 is still NOT the generic message")
    print(f"  {OK if not _tool_names(second) else NO} but turn 2 navigates NOWHERE — the same "
          "request now fails, with the member's own collections invisible")


async def main() -> None:
    await e1_model_call_topology()
    await e2_large_library_limiter()
    await e2b_second_turn_in_the_same_window()
    await e3_supervisor_failure()
    await e4_node_failure_never_trips_breaker()


if __name__ == "__main__":
    asyncio.run(main())
