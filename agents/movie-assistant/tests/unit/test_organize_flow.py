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
    collections: list[dict[str, Any]] | None = None,
    execute_calls: list[Any] | None = None,
    execute_result: Any = None,
) -> Any:
    movie_rows = movies if movies is not None else _MOVIES
    collection_rows = collections if collections is not None else _COLLECTIONS
    calls = execute_calls if execute_calls is not None else []
    ids = iter(f"p{i}" for i in range(1, 100))

    async def list_collections() -> list[dict[str, Any]]:
        return collection_rows

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


async def test_organize_preview_emits_collection_summary_tool_call() -> None:
    # The preview carries a render_collection_summary generative-UI tool call (T052) so the
    # dock shows the affected collection inline.
    graph = _build(plan=_remove("The Matrix"))
    paused = await graph.ainvoke({"messages": [("user", "remove The Matrix")]}, _config("org-sum"))
    tool_calls = [
        tc for m in paused["messages"] for tc in (getattr(m, "tool_calls", None) or [])
    ]
    rcs = next(tc for tc in tool_calls if tc["name"] == "render_collection_summary")
    assert rcs["args"]["name"] == "Sci-Fi"
    assert rcs["args"]["movieCount"] == 3
    assert rcs["args"]["role"] == "owner"  # defaulted when the list omits it


# ── update / move slice (T070) ────────────────────────────────────────────────

_TWO_COLLECTIONS = [
    {"collectionId": "c1", "name": "Sci-Fi", "isDefault": False, "movieCount": 2},
    {"collectionId": "c2", "name": "Favorites", "isDefault": False, "movieCount": 0},
]
_FULL_MOVIES = [
    {"movieId": "m1", "collectionId": "c1", "title": "The Matrix", "owned": False, "tags": []},
    {
        "movieId": "m2", "collectionId": "c1", "title": "Inception",
        "owned": False, "tags": ["scifi"],
    },
]


def _update(title: str, changes: dict[str, Any]) -> dict[str, Any]:
    return {
        "collection": "Sci-Fi",
        "operations": [{"op": "update", "title": title, "changes": changes}],
    }


def _move(title: str, to: str) -> dict[str, Any]:
    return {"collection": "Sci-Fi", "operations": [{"op": "move", "title": title, "to": to}]}


async def test_organize_update_owned_applies_full_replace_payload() -> None:
    calls: list[Any] = []
    graph = _build(
        plan=_update("Inception", {"owned": True}), movies=_FULL_MOVIES, execute_calls=calls
    )
    cfg = _config("org-update")

    paused = await graph.ainvoke({"messages": [("user", "mark Inception as owned")]}, cfg)
    assert "__interrupt__" in paused
    assert calls == []  # nothing applied before approval (FR-007)

    final = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)
    assert final["status"] == "completed"
    update = [args for op, args, _ in calls if op == "update"]
    assert len(update) == 1
    assert update[0]["collectionId"] == "c1"
    assert update[0]["movieId"] == "m2"
    assert update[0]["movie"]["owned"] is True
    assert "movieId" not in update[0]["movie"]  # the full-replace payload carries no server id


async def test_organize_move_adds_to_dest_then_removes_from_source() -> None:
    calls: list[Any] = []
    graph = _build(
        plan=_move("Inception", "Favorites"),
        collections=_TWO_COLLECTIONS,
        movies=_FULL_MOVIES,
        execute_calls=calls,
    )
    cfg = _config("org-move")

    await graph.ainvoke({"messages": [("user", "move Inception to Favorites")]}, cfg)
    final = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)
    assert final["status"] == "completed"

    assert [op for op, _, _ in calls] == ["add", "remove"]
    add_args = next(args for op, args, _ in calls if op == "add")
    assert add_args["collectionId"] == "c2"
    assert add_args["movie"]["title"] == "Inception"
    remove_args = next(args for op, args, _ in calls if op == "remove")
    assert remove_args == {"collectionId": "c1", "movieId": "m2"}


async def test_organize_move_to_unknown_collection_is_reported_not_applied() -> None:
    calls: list[Any] = []
    graph = _build(
        plan=_move("Inception", "Nonexistent"),
        collections=_TWO_COLLECTIONS,
        movies=_FULL_MOVIES,
        execute_calls=calls,
    )
    cfg = _config("org-move-bad")

    result = await graph.ainvoke({"messages": [("user", "move Inception to Nonexistent")]}, cfg)
    assert "__interrupt__" not in result  # no proposal built — never auto-creates the dest
    text = " ".join(str(m.content) for m in result["messages"])
    assert "Nonexistent" in text  # the unresolvable destination is surfaced
    assert calls == []


async def test_organize_resolves_title_with_year_suffix() -> None:
    # The model often echoes the disambiguation label "Title (Year)", but the stored movie title
    # is bare ("Avatar"). The "(2009)" suffix must not break resolution (live bug: "couldn't find
    # Avatar (2009)" for a movie that exists in the collection).
    movies = [{"movieId": "m1", "title": "Avatar"}]
    graph = _build(plan=_remove("Avatar (2009)"), movies=movies)
    cfg = _config("org-year-suffix")
    paused = await graph.ainvoke({"messages": [("user", "remove Avatar (2009)")]}, cfg)
    assert "__interrupt__" in paused  # resolved despite the (2009) suffix
    assert len(paused["__interrupt__"][0].value["items"]) == 1


async def test_organize_year_pins_the_correct_same_title_film() -> None:
    # Uniqueness is (title, year): a collection can hold two films with the same title. A naive
    # year-STRIP would collapse them and match the wrong one — the year must pin the right film.
    movies = [
        {"movieId": "old", "title": "Dune", "year": 1984},
        {"movieId": "new", "title": "Dune", "year": 2021},
    ]
    calls: list[Any] = []
    graph = _build(plan=_remove("Dune (1984)"), movies=movies, execute_calls=calls)
    cfg = _config("org-year-pin")
    paused = await graph.ainvoke({"messages": [("user", "remove Dune (1984)")]}, cfg)
    assert "__interrupt__" in paused
    assert len(paused["__interrupt__"][0].value["items"]) == 1
    await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)
    removed = {args["movieId"] for op, args, _ in calls if op == "remove"}
    assert removed == {"old"}  # the 1984 film, NOT the 2021 one


async def test_organize_bare_title_is_ambiguous_across_years() -> None:
    # Without a year, two same-title films cannot be safely disambiguated → resolve to nothing
    # (report), never silently pick one.
    movies = [
        {"movieId": "old", "title": "Dune", "year": 1984},
        {"movieId": "new", "title": "Dune", "year": 2021},
    ]
    graph = _build(plan=_remove("Dune"), movies=movies)
    cfg = _config("org-bare-ambig")
    result = await graph.ainvoke({"messages": [("user", "remove Dune")]}, cfg)
    assert "__interrupt__" not in result  # ambiguous bare title → no silent guess


async def test_organize_wrong_year_does_not_match_a_different_year_film() -> None:
    # The op names a year that no stored (title, year) has → not found (never match by title alone
    # when both sides carry a year).
    movies = [{"movieId": "m1", "title": "Avatar", "year": 2009}]
    graph = _build(plan=_remove("Avatar (2022)"), movies=movies)
    cfg = _config("org-wrong-year")
    result = await graph.ainvoke({"messages": [("user", "remove Avatar (2022)")]}, cfg)
    assert "__interrupt__" not in result  # year disagrees → reported, not matched


async def test_organize_move_title_with_year_suffix_resolves() -> None:
    # Exact bug-2 reproduction: "move Avatar (2009) to Wishlist" with the movie stored as "Avatar".
    movies = [
        {"movieId": "m1", "collectionId": "c1", "title": "Avatar", "owned": False, "tags": []}
    ]
    cols = [
        {"collectionId": "c1", "name": "Movie Collection", "isDefault": True, "movieCount": 1},
        {"collectionId": "c2", "name": "Wishlist", "isDefault": False, "movieCount": 0},
    ]
    plan = {
        "collection": "Movie Collection",
        "operations": [{"op": "move", "title": "Avatar (2009)", "to": "Wishlist"}],
    }
    graph = _build(plan=plan, movies=movies, collections=cols)
    cfg = _config("org-move-year")
    paused = await graph.ainvoke(
        {"messages": [("user", "move Avatar (2009) to Wishlist")]}, cfg
    )
    assert "__interrupt__" in paused  # resolved despite the (2009) suffix → move proposal built


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
