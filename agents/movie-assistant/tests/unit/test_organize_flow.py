"""Graph-level organize flow (US2, T050b): plan → resolve → batch preview → approve → apply.

Exercises the COMPILED graph with the REAL organizer + approval_gate wired together (stub
plan/list_collections/list_movies/execute closures + MemorySaver) so the full HITL path —
including chunked sequential batches (FR-009b) and approval-time re-validation that skips
drifted items without aborting the batch (FR-009a / SC-010) — is deterministic without
Keycloak/MCP/mc-service. The live tool path is T047 (integration).

MVP organize scope = multi-item REMOVE within a collection (update/move are follow-ups; the
proposals/apply/movie-mcp layers already support update for when it lands).
"""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src.graph import build_graph
from src.nodes.approval_gate import ExecOutcome, build_approval_gate
from src.nodes.organizer import build_organizer

_COLLECTIONS = [{"collectionId": "c1", "name": "Sci-Fi", "isDefault": False, "movieCount": 3}]
_MOVIES = [
    {"movieId": "m1", "title": "The Matrix"},
    {"movieId": "m2", "title": "Inception"},
    {"movieId": "m3", "title": "Coherence"},
]


def _build(
    *,
    plan: dict[str, Any],
    movies: list[dict[str, Any]] | None = None,
    execute_calls: list[Any] | None = None,
    execute_result: Any = None,
) -> Any:
    movie_rows = movies if movies is not None else _MOVIES
    calls = execute_calls if execute_calls is not None else []
    ids = iter(f"p{i}" for i in range(1, 100))

    async def list_collections() -> list[dict[str, Any]]:
        return _COLLECTIONS

    async def list_movies(_collection_id: str) -> list[dict[str, Any]]:
        return movie_rows

    def plan_fn(_messages: Any) -> dict[str, Any]:
        return plan

    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        calls.append((str(operation), args, key))
        if execute_result is not None:
            return execute_result(operation, args)
        return ExecOutcome(status="applied")

    return build_graph(
        classifier=lambda _m: "organize",
        organizer=build_organizer(
            list_collections=list_collections,
            list_movies=list_movies,
            plan=plan_fn,
            gen_id=lambda: next(ids),
        ),
        approval_gate=build_approval_gate(execute=execute),
        checkpointer=MemorySaver(),
    )


def _config(thread: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread}}


def _remove(*titles: str) -> dict[str, Any]:
    return {"collection": "Sci-Fi", "operations": [{"op": "remove", "title": t} for t in titles]}


async def test_organize_remove_batch_previews_then_applies_all_on_approval() -> None:
    calls: list[Any] = []
    graph = _build(plan=_remove("The Matrix", "Inception"), execute_calls=calls)
    cfg = _config("org-1")

    paused = await graph.ainvoke(
        {"messages": [("user", "remove The Matrix and Inception from Sci-Fi")]}, cfg
    )
    assert "__interrupt__" in paused  # batch preview, nothing applied yet
    payload = paused["__interrupt__"][0].value
    assert payload["type"] == "approval_request"
    assert len(payload["items"]) == 2
    assert calls == []  # no writes before approval (FR-007)

    final = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)
    assert final["status"] == "completed"
    removed = {args["movieId"] for op, args, _ in calls if op == "remove"}
    assert removed == {"m1", "m2"}


async def test_organize_reject_writes_nothing() -> None:
    calls: list[Any] = []
    graph = _build(plan=_remove("The Matrix"), execute_calls=calls)
    cfg = _config("org-reject")
    await graph.ainvoke({"messages": [("user", "remove The Matrix from Sci-Fi")]}, cfg)
    final = await graph.ainvoke(Command(resume={"decision": "rejected"}), cfg)
    assert final["status"] == "completed"
    assert calls == []  # FR-007


async def test_organize_skips_unresolved_title_not_in_collection() -> None:
    # "Dune" is not in the collection → it is reported, not put in the proposal.
    graph = _build(plan=_remove("The Matrix", "Dune"))
    cfg = _config("org-unresolved")
    paused = await graph.ainvoke({"messages": [("user", "remove The Matrix and Dune")]}, cfg)
    payload = paused["__interrupt__"][0].value
    assert len(payload["items"]) == 1  # only the resolvable one
    text = " ".join(str(m.content) for m in paused["messages"])
    assert "Dune" in text  # the unresolved title is surfaced to the user


async def test_organize_drift_skips_missing_item_without_aborting_batch() -> None:
    # m2 drifted (deleted since the proposal) → mc-service 404 → skipped_missing; m1 still applies.
    def result(operation: Any, args: dict[str, Any]) -> ExecOutcome:
        if args.get("movieId") == "m2":
            return ExecOutcome(status="skipped_missing")
        return ExecOutcome(status="applied")

    graph = _build(plan=_remove("The Matrix", "Inception"), execute_result=result)
    cfg = _config("org-drift")
    await graph.ainvoke({"messages": [("user", "remove two")]}, cfg)
    final = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)
    res = final["apply_result"]
    assert res.applied_item_ids and res.skipped_item_ids  # one applied, one skipped, no abort


async def test_organize_oversized_request_chunks_into_sequential_approvals() -> None:
    titles = [f"M{i}" for i in range(120)]
    movies = [{"movieId": f"id{i}", "title": f"M{i}"} for i in range(120)]
    calls: list[Any] = []
    graph = _build(plan=_remove(*titles), movies=movies, execute_calls=calls)
    cfg = _config("org-chunk")

    first = await graph.ainvoke({"messages": [("user", "remove all 120")]}, cfg)
    assert len(first["__interrupt__"][0].value["items"]) == 50  # batch 1 of 3

    second = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)
    assert "__interrupt__" in second  # batch 2 previewed after batch 1 applied
    assert len(second["__interrupt__"][0].value["items"]) == 50

    third = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)
    assert "__interrupt__" in third
    assert len(third["__interrupt__"][0].value["items"]) == 20  # batch 3 (remainder)

    done = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)
    assert done["status"] == "completed"
    assert len([c for c in calls if c[0] == "remove"]) == 120  # all applied across 3 batches
