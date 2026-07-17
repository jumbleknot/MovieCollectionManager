"""Proposal expiry at session end (T062, FR-008 / SC-007).

A pending proposal must expire — writing nothing — when the user's session ends. The
`approval_gate` already guarantees nothing auto-applies (it pauses at `interrupt()` and writes
only on an explicit approved resume). These tests prove the session-end SWEEP: clearing the
pending proposal in a thread's checkpoint so a *late* resume (after the session ended) applies
ZERO writes (SC-007), while the sweep itself performs no domain write.

Graph-level via the compiled add-flow graph with stub tools + MemorySaver (mirrors
test_add_flow_graph / test_disambiguation_flow): drive an add to the approval interrupt, sweep,
then resume — and assert the write executor was never called.
"""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src.graph import build_graph
from src.nodes.approval_gate import ExecOutcome, build_approval_gate
from src.nodes.curator import build_curator
from src.nodes.organizer import build_organizer
from src.session_expiry import (
    expire_pending_proposal,
    has_pending_proposal,
    sweep_thread,
    sweep_threads,
)

_DETAIL = {
    "source": "tmdb", "sourceId": "tmdb:603", "title": "The Matrix", "year": 1999,
    "overview": "x", "genres": ["Science Fiction"], "posterUrl": "http://x", "language": "English",
}
_COLLECTIONS = [{"collectionId": "a" * 24, "name": "Sci-Fi", "isDefault": False, "movieCount": 0}]


def _classifier(_messages: Any) -> str:
    return "add"


def _extract(_messages: Any) -> dict[str, Any]:
    return {"title": "The Matrix", "year": 1999, "collection": "Sci-Fi"}


async def _search(_query: str, _year: int | None) -> dict[str, Any]:
    return {"matchConfidence": "exact", "results": [{"sourceId": "tmdb:603"}]}


async def _details(_source_id: str) -> dict[str, Any]:
    return _DETAIL


def _build(execute: Any) -> Any:
    async def list_collections() -> list[dict[str, Any]]:
        return _COLLECTIONS

    return build_graph(
        classifier=_classifier,
        curator=build_curator(extract=_extract, search=_search, details=_details),
        organizer=build_organizer(list_collections=list_collections, gen_id=lambda: "p1"),
        approval_gate=build_approval_gate(execute=execute),
        checkpointer=MemorySaver(),
    )


def _recording_execute() -> tuple[list[Any], Any]:
    calls: list[Any] = []

    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        calls.append((str(operation), args, key))
        return ExecOutcome(status="applied", data={"movieId": "m1"})

    return calls, execute


async def _add_to_interrupt(graph: Any, thread_id: str) -> dict[str, Any]:
    cfg = {"configurable": {"thread_id": thread_id}}
    turn1 = await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    assert "__interrupt__" not in turn1  # 040 US4: asks ownership before the approval gate
    result = await graph.ainvoke({"messages": [("user", "yes")]}, cfg)  # answer → approval gate
    assert "__interrupt__" in result  # paused with a pending proposal awaiting approval
    return cfg


# ── pure transform ──────────────────────────────────────────────────────────────────────────


def test_expire_pending_proposal_clears_pending_and_marks_expired() -> None:
    update = expire_pending_proposal({"pending_proposal": object(), "status": "awaiting_approval"})
    assert update["pending_proposal"] is None
    assert update["pending_batches"] == []
    assert update["status"] == "expired"


def test_expire_pending_proposal_is_a_noop_when_nothing_pending() -> None:
    assert expire_pending_proposal({"status": "completed", "messages": []}) == {}
    assert expire_pending_proposal({"pending_proposal": None, "pending_batches": []}) == {}


# ── the SC-007 crux: a swept thread's late resume writes nothing ──────────────────────────────


async def test_swept_thread_resume_applies_zero_writes() -> None:
    calls, execute = _recording_execute()
    graph = _build(execute)
    cfg = await _add_to_interrupt(graph, "expire-1")

    assert has_pending_proposal(graph.get_state(cfg).values)  # a proposal is pending pre-sweep

    assert sweep_thread(graph, "expire-1") is True  # session ends → expire it
    swept = graph.get_state(cfg).values
    assert not has_pending_proposal(swept)  # cleared
    assert swept.get("status") == "expired"
    assert calls == []  # the sweep itself wrote nothing

    # FR-008 / SC-007: a late approved resume after expiry must apply NOTHING.
    await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)
    assert calls == []


async def test_sweep_is_idempotent_and_noop_on_clean_thread() -> None:
    calls, execute = _recording_execute()
    graph = _build(execute)
    await _add_to_interrupt(graph, "expire-2")

    assert sweep_thread(graph, "expire-2") is True
    assert sweep_thread(graph, "expire-2") is False  # nothing pending the second time
    assert sweep_thread(graph, "never-existed") is False  # no checkpoint → no-op


async def test_sweep_threads_expires_only_pending_threads() -> None:
    calls, execute = _recording_execute()
    graph = _build(execute)
    await _add_to_interrupt(graph, "pending-a")
    await _add_to_interrupt(graph, "pending-b")
    # "clean-c" never started an add → no pending proposal.

    expired = sweep_threads(graph, ["pending-a", "pending-b", "clean-c"])
    assert expired == 2
    for tid in ("pending-a", "pending-b"):
        cfg = {"configurable": {"thread_id": tid}}
        assert not has_pending_proposal(graph.get_state(cfg).values)
    assert calls == []  # no domain writes from sweeping
