"""Graph-level add flow: route → enrich → propose → interrupt → resume → apply (US1).

Exercises the COMPILED graph with the REAL curator/organizer/approval_gate nodes wired
together, using STUB tool closures + an in-process MemorySaver — so the full HITL path
(including LangGraph `interrupt()`/resume) is deterministic without Keycloak/MCP/mc-service.
The live tool path is T036 (integration). The production graph stays tool-free until the
agent layer is deployed (defaults unchanged → SC-005 regression unaffected).
"""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src.graph import build_graph
from src.nodes.approval_gate import ExecOutcome
from src.nodes.curator import build_curator
from src.nodes.organizer import build_organizer

_DETAILS = {
    "source": "tmdb", "sourceId": "tmdb:603", "title": "The Matrix", "year": 1999,
    "overview": "x", "genres": ["Science Fiction"], "posterUrl": "http://x", "language": "English",
}


async def _search_exact(_q: str, _y: int | None) -> dict[str, Any]:
    return {"matchConfidence": "exact", "results": [{"sourceId": "tmdb:603"}]}


async def _details(_sid: str) -> dict[str, Any]:
    return _DETAILS


async def _list_existing() -> list[dict[str, Any]]:
    return [{"collectionId": "0123456789abcdef01234567", "name": "Sci-Fi", "movieCount": 0}]


def _build(execute_calls: list[Any]) -> Any:
    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        execute_calls.append((str(operation), args, key))
        return ExecOutcome(status="applied", data={"movieId": "m1"})

    return build_graph(
        classifier=lambda _m: "add",
        curator=build_curator(
            extract=lambda _m: {"title": "The Matrix", "year": 1999, "collection": "Sci-Fi"},
            search=_search_exact, details=_details,
        ),
        organizer=build_organizer(list_collections=_list_existing, gen_id=lambda: "p1"),
        approval_gate=build_approval_gate_for(execute),
        checkpointer=MemorySaver(),
    )


def build_approval_gate_for(execute: Any) -> Any:
    from src.nodes.approval_gate import build_approval_gate

    return build_approval_gate(execute=execute)


def _config(thread: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread}}


async def test_add_flow_pauses_at_approval_with_a_proposal() -> None:
    graph = _build([])
    result = await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        _config("add-1"),
    )
    assert "__interrupt__" in result  # paused at the approval gate
    payload = result["__interrupt__"][0].value
    assert payload["type"] == "approval_request"
    assert payload["proposalId"] == "p1"


async def test_add_flow_applies_once_on_approval() -> None:
    calls: list[Any] = []
    graph = _build(calls)
    cfg = _config("add-approve")
    await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    final = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)

    assert final["status"] == "completed"
    add_calls = [c for c in calls if c[0] == "add"]
    assert len(add_calls) == 1  # exactly one add executed (SC-006)
    assert add_calls[0][1]["collectionId"] == "0123456789abcdef01234567"


async def test_add_flow_writes_nothing_on_rejection() -> None:
    calls: list[Any] = []
    graph = _build(calls)
    cfg = _config("add-reject")
    await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    final = await graph.ainvoke(Command(resume={"decision": "rejected"}), cfg)

    assert final["status"] == "completed"
    assert calls == []  # zero writes when rejected (FR-007)
