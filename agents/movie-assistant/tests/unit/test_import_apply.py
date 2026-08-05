"""T034 (apply path): an import create applies via Operation.add carrying a RAW movie_payload.

US1-add/US2-organize items carry an EnrichedMovieCandidate; an import create instead carries a
fully-composed `movie_payload` (no TMDB candidate). apply_proposal's add branch must use the raw
payload when there is no candidate — without re-deriving it — so import creates reuse the exact
same HITL gate + idempotency-keyed at-most-once apply. The candidate path is unchanged.
"""

from __future__ import annotations

from typing import Any

from src.nodes.approval_gate import (
    ExecOutcome,
    _build_import_report,
    _import_summary_message,
    apply_proposal,
    build_approval_request,
)
from src.proposals import EnrichedMovieCandidate, Operation, Proposal, ProposalItem, ProposalKind


def _recording_execute() -> tuple[list[dict[str, Any]], Any]:
    calls: list[dict[str, Any]] = []

    async def execute(operation: Operation, args: dict[str, Any], key: str) -> ExecOutcome:
        calls.append({"operation": operation, "args": args, "key": key})
        return ExecOutcome(status="applied", data={"movieId": "new"})

    return calls, execute


async def test_import_create_applies_raw_payload() -> None:
    payload = {"title": "Dune", "year": 2021, "contentType": "Movie", "owned": True, "genres": []}
    proposal = Proposal(
        proposal_id="import:t:0",
        kind=ProposalKind.batch,
        items=[
            ProposalItem(
                item_id="i0",
                operation=Operation.add,
                movie_payload=payload,
                movie_ref={"collectionId": "c-scifi"},
                idempotency_key="k0",
            )
        ],
    )
    calls, execute = _recording_execute()
    result = await apply_proposal(proposal, execute=execute)

    assert result.applied_item_ids == ["i0"]
    assert len(calls) == 1
    assert calls[0]["operation"] == Operation.add
    assert calls[0]["args"] == {"collectionId": "c-scifi", "movie": payload}
    assert calls[0]["key"] == "k0"


async def test_add_without_candidate_or_payload_is_skipped_missing() -> None:
    proposal = Proposal(
        proposal_id="p",
        kind=ProposalKind.batch,
        items=[
            ProposalItem(
                item_id="i0",
                operation=Operation.add,
                movie_ref={"collectionId": "c"},
                idempotency_key="k0",
            )
        ],
    )
    calls, execute = _recording_execute()
    result = await apply_proposal(proposal, execute=execute)
    assert result.skipped_item_ids == ["i0"]
    assert calls == []  # nothing to add → no write attempted


def _import_proposal() -> Proposal:
    """A two-tab import proposal carrying a tab-level summary (the confirm-once shape)."""
    return Proposal(
        proposal_id="import:t",
        kind=ProposalKind.batch,
        items=[
            ProposalItem(
                item_id="a0", operation=Operation.add,
                movie_payload={"title": "Dune"}, movie_ref={"collectionId": "c1"},
                diff={"tab": "Sci-Fi"}, idempotency_key="k0",
            ),
            ProposalItem(
                item_id="a1", operation=Operation.add,
                movie_payload={"title": "Alien"}, movie_ref={"collectionId": "c2"},
                diff={"tab": "Horror"}, idempotency_key="k1",
            ),
        ],
        import_summary={
            "tabs": [
                {"tabName": "Sci-Fi", "collectionName": "Sci-Fi", "createCount": 1,
                 "updateCount": 0, "skippedCount": 0},
                {"tabName": "Horror", "collectionName": "Horror", "createCount": 1,
                 "updateCount": 0, "skippedCount": 0},
            ],
            "ignoredTabs": [], "totalCreate": 2, "totalUpdate": 0,
        },
    )


def test_import_proposal_previews_as_a_summary_not_per_item() -> None:
    payload = build_approval_request(_import_proposal())
    assert payload["type"] == "import_preview"
    assert "items" not in payload
    assert [t["tabName"] for t in payload["summary"]["tabs"]] == ["Sci-Fi", "Horror"]


async def test_excluded_tab_items_are_dropped_not_written() -> None:
    calls, execute = _recording_execute()
    result = await apply_proposal(_import_proposal(), execute=execute, excluded_tabs=["Horror"])
    assert result.applied_item_ids == ["a0"]  # Sci-Fi written
    assert result.excluded_item_ids == ["a1"]  # Horror dropped
    assert [c["args"]["movie"]["title"] for c in calls] == ["Dune"]  # only the included tab


async def test_no_exclusions_applies_every_tab() -> None:
    calls, execute = _recording_execute()
    result = await apply_proposal(_import_proposal(), execute=execute)
    assert result.applied_item_ids == ["a0", "a1"]
    assert result.excluded_item_ids == []
    assert len(calls) == 2


async def test_failed_item_records_title_and_reason_and_surfaces_in_summary() -> None:
    """A failed import write must record WHICH movie failed and WHY, and the summary lists it."""
    proposal = Proposal(
        proposal_id="import:t",
        kind=ProposalKind.batch,
        items=[
            ProposalItem(
                item_id="u0", operation=Operation.update,
                movie_payload={"title": "Heat", "year": 1995},
                movie_ref={"collectionId": "c1", "movieId": "m1"},
                diff={"update_movie": "Heat", "tab": "Sample"}, idempotency_key="k0",
            ),
            ProposalItem(
                item_id="a1", operation=Operation.add,
                movie_payload={"title": "Dune"}, movie_ref={"collectionId": "c1"},
                diff={"add_movie": "Dune", "tab": "Sample"}, idempotency_key="k1",
            ),
        ],
        import_summary={"tabs": [], "ignoredTabs": [], "totalCreate": 1, "totalUpdate": 1},
    )

    async def execute(operation: Operation, args: dict[str, Any], key: str) -> ExecOutcome:
        if operation == Operation.update:
            return ExecOutcome(status="failed", error="422 invalid value")
        return ExecOutcome(status="applied", data={"movieId": "new"})

    result = await apply_proposal(proposal, execute=execute)
    assert result.failed_item_ids == ["u0"]
    assert result.failures == [{"title": "Heat", "reason": "422 invalid value"}]

    # The completion text is concise; the per-row WHICH + WHY lives in the report card.
    msg = _import_summary_message(result)
    assert "1 could not be imported" in msg
    assert "import report" in msg.lower()

    # The report builder surfaces the failed row's title + reason (what the card renders).
    report = _build_import_report(proposal, result)
    assert report["failed"] == [{"title": "Heat", "reason": "422 invalid value"}]


async def test_import_report_combines_plan_skips_and_apply_failures() -> None:
    """Enhancement 3: the report unifies rows skipped BEFORE write (from the proposal summary) and
    rows mc-service REJECTED at write time (apply failures)."""
    proposal = Proposal(
        proposal_id="import:t",
        kind=ProposalKind.batch,
        items=[
            ProposalItem(
                item_id="u0", operation=Operation.update,
                movie_payload={"title": "Heat"},
                movie_ref={"collectionId": "c1", "movieId": "m1"},
                diff={"update_movie": "Heat"}, idempotency_key="k0",
            )
        ],
        import_summary={"tabs": [], "skipped": [{"title": "Bad", "reason": "invalid Year"}]},
    )

    async def execute(operation: Operation, args: dict[str, Any], key: str) -> ExecOutcome:
        return ExecOutcome(status="failed", error="Owned must be true or false (mc-service 422)")

    result = await apply_proposal(proposal, execute=execute)
    report = _build_import_report(proposal, result)
    assert report["skipped"] == [{"title": "Bad", "reason": "invalid Year"}]
    assert report["failed"] == [
        {"title": "Heat", "reason": "Owned must be true or false (mc-service 422)"}
    ]


async def test_candidate_add_path_unchanged() -> None:
    """Regression: an item WITH a candidate still applies via to_movie_payload(candidate)."""
    candidate = EnrichedMovieCandidate(sourceId="tmdb:603", title="The Matrix", year=1999)
    proposal = Proposal(
        proposal_id="p",
        kind=ProposalKind.batch,
        items=[
            ProposalItem(
                item_id="i0",
                operation=Operation.add,
                movie_candidate=candidate,
                movie_ref={"collectionId": "c"},
                idempotency_key="k0",
            )
        ],
    )
    calls, execute = _recording_execute()
    result = await apply_proposal(proposal, execute=execute)
    assert result.applied_item_ids == ["i0"]
    assert calls[0]["args"]["movie"]["title"] == "The Matrix"


# ── 047 US3 (T044c): the apply loop must not block the gateway ───────────────────────────────────

import asyncio  # noqa: E402

from src.nodes.approval_gate import apply_proposal as _apply  # noqa: E402
from src.proposals import (  # noqa: E402
    CollectionRef,
)


def _bulk_proposal(n: int) -> Proposal:
    return Proposal(
        proposal_id="import:responsive",
        kind=ProposalKind.batch,
        items=[
            ProposalItem(
                item_id=f"row-{i}",
                operation=Operation.add,
                movie_payload={"title": f"Film {i}", "year": 2000},
                idempotency_key=f"key:row-{i}",
            )
            for i in range(n)
        ],
        target_collection=CollectionRef(collection_id="c-1", name="Imported"),
    )


async def test_apply_stays_responsive_to_other_work(monkeypatch: Any) -> None:
    """FR-017 / US3-AC6: a member's next message is answered WHILE a big import runs.

    The gateway is one process serving every turn, so an apply loop that holds the event loop
    makes the assistant look hung for the duration of a 2,000-row import. This schedules a
    coroutine alongside the apply and requires it to make progress before the apply finishes.
    """
    from src.nodes.approval_gate import ExecOutcome

    ticks = 0
    apply_done = asyncio.Event()

    async def other_turn() -> None:
        nonlocal ticks
        while not apply_done.is_set():
            ticks += 1
            await asyncio.sleep(0.001)

    async def execute(_op: Any, _args: dict[str, Any], _key: str) -> ExecOutcome:
        await asyncio.sleep(0.002)  # a real write is I/O-bound
        return ExecOutcome(status="applied", data={"movieId": "m"})

    companion = asyncio.create_task(other_turn())
    try:
        result = await _apply(_bulk_proposal(200), execute=execute)
    finally:
        apply_done.set()
        await companion

    assert len(result.applied_item_ids) == 200
    assert ticks > 5, (
        f"the concurrent turn advanced only {ticks} times during a 200-item apply — "
        "the apply loop is starving the event loop (FR-017)"
    )
