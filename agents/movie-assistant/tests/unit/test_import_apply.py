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


# ── 047 US3 (T045): re-running a partially applied import creates no duplicates ──────────────────


async def test_rerun_no_duplicates_under_concurrent_apply() -> None:
    """FR-018: the second run of a half-applied import adds only what is missing.

    Two independent mechanisms have to survive the concurrency rewrite: the per-item idempotency
    key (at-most-once for the SAME item) and the 409 -> skipped_duplicate classification (the
    server's (title, year) uniqueness catching a row the plan thought was new). This exercises
    both — the first run applies half the rows, the second replays ALL of them.
    """
    from src.nodes.approval_gate import ExecOutcome

    stored: set[str] = set()
    keys_seen: list[str] = []

    async def execute(_op: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        keys_seen.append(key)
        title = str((args.get("movie") or {}).get("title") or "")
        if title in stored:
            # What mc-service's (title, year) uniqueness produces, mapped at the runtime boundary.
            return ExecOutcome(status="skipped_duplicate")
        stored.add(title)
        return ExecOutcome(status="applied", data={"movieId": f"m-{title}"})

    # First run: only the first 100 rows land (the rest are "interrupted").
    first = _bulk_proposal(100)
    run_one = await _apply(first, execute=execute)
    assert len(run_one.applied_item_ids) == 100
    assert len(stored) == 100

    # Second run replays all 200 — the original 100 must come back as skipped, not duplicated.
    run_two = await _apply(_bulk_proposal(200), execute=execute)

    assert len(stored) == 200, f"re-import created duplicates: {len(stored)} distinct titles"
    assert len(run_two.applied_item_ids) == 100, (
        f"expected 100 newly applied, got {len(run_two.applied_item_ids)}"
    )
    assert len(run_two.skipped_item_ids) == 100, (
        f"expected 100 reported as already present, got {len(run_two.skipped_item_ids)}"
    )
    assert run_two.failed_item_ids == [], "a duplicate was reported as a failure, not a skip"


async def test_duplicate_classification_is_stable_across_concurrent_completion_order() -> None:
    """The 409 -> skipped_duplicate mapping must not depend on which write finishes first."""
    from src.nodes.approval_gate import ExecOutcome

    async def execute(_op: Any, args: dict[str, Any], _key: str) -> ExecOutcome:
        title = str((args.get("movie") or {}).get("title") or "")
        index = int(title.rsplit(" ", 1)[-1] or 0)
        await asyncio.sleep((40 - index) * 0.0005)  # later rows finish first
        return ExecOutcome(status="skipped_duplicate") if index % 2 else ExecOutcome(
            status="applied", data={"movieId": "m"}
        )

    result = await _apply(_bulk_proposal(40), execute=execute)

    assert result.applied_item_ids == [f"row-{i}" for i in range(0, 40, 2)]
    assert result.skipped_item_ids == [f"row-{i}" for i in range(1, 40, 2)]


# ── 047 US3 (T049): progress while a large import applies ────────────────────────────────────────
#
# FR-014a: ONE progress surface per run that updates IN PLACE — not a message per batch, which is
# the flood the requirement exists to prevent. FR-014b: at the end that same surface is replaced
# by the final report. SC-008: it advances at least every 10 s, so a member never watches a
# stalled number and concludes the import died.


async def test_progress_reports_advance_during_a_large_apply() -> None:
    from src.nodes.approval_gate import ExecOutcome

    seen: list[tuple[int, int]] = []

    async def on_progress(applied: int, total: int, _state: str = "running") -> None:
        seen.append((applied, total))

    async def execute(_op: Any, _args: dict[str, Any], _key: str) -> ExecOutcome:
        await asyncio.sleep(0)
        return ExecOutcome(status="applied", data={"movieId": "m"})

    result = await _apply(_bulk_proposal(500), execute=execute, on_progress=on_progress)

    assert len(result.applied_item_ids) == 500
    assert seen, "no progress was reported during a 500-item apply"
    counts = [applied for applied, _ in seen]
    assert counts == sorted(counts), f"progress went backwards: {counts[:10]}"
    assert all(total == 500 for _, total in seen), "the total changed mid-run"
    assert counts[-1] == 500, f"the last progress report was {counts[-1]}, not the full 500"


async def test_progress_is_throttled_not_one_per_item() -> None:
    """FR-014a exists to stop a message flood — 2,000 emissions is the flood in another costume."""
    from src.nodes.approval_gate import ExecOutcome

    seen: list[tuple[int, int]] = []

    async def on_progress(applied: int, total: int, _state: str = "running") -> None:
        seen.append((applied, total))

    async def execute(_op: Any, _args: dict[str, Any], _key: str) -> ExecOutcome:
        return ExecOutcome(status="applied", data={"movieId": "m"})

    await _apply(_bulk_proposal(2000), execute=execute, on_progress=on_progress)

    assert len(seen) < 2000 / 4, (
        f"emitted {len(seen)} progress updates for 2,000 items — that is a flood, not a line"
    )
    assert len(seen) >= 2, "a 2,000-item apply reported progress fewer than twice"


async def test_progress_reaches_the_total_even_when_items_are_skipped_or_fail() -> None:
    """The counter must track ITEMS PROCESSED, not items applied — otherwise a run with
    duplicates ends at "1,400 of 2,000" and looks stalled forever (FR-014b)."""
    from src.nodes.approval_gate import ExecOutcome

    seen: list[tuple[int, int]] = []

    async def on_progress(applied: int, total: int, _state: str = "running") -> None:
        seen.append((applied, total))

    async def execute(_op: Any, args: dict[str, Any], _key: str) -> ExecOutcome:
        title = str((args.get("movie") or {}).get("title") or "")
        index = int(title.rsplit(" ", 1)[-1] or 0)
        if index % 3 == 0:
            return ExecOutcome(status="skipped_duplicate")
        if index % 7 == 0:
            return ExecOutcome(status="failed", error="nope")
        return ExecOutcome(status="applied", data={"movieId": "m"})

    await _apply(_bulk_proposal(300), execute=execute, on_progress=on_progress)

    assert seen[-1] == (300, 300), (
        f"progress ended at {seen[-1]} — a run with skips/failures must still reach its total"
    )


# ── 047 US3 (T053): a throttled write says so (FR-019b) ──────────────────────────────────────────


async def test_waiting_note_when_a_write_is_throttled() -> None:
    """FR-019b: if a bulk import IS throttled despite its allowance, say it is waiting.

    The failure this prevents is silent: the counter stops advancing and the member watches a
    frozen "1,300 of 2,300" with no way to tell a slow import from a dead one. The progress
    callback carries a state so the line can say "waiting" instead of just not moving.
    """
    from src.nodes.approval_gate import ExecOutcome

    seen: list[tuple[int, int, str]] = []

    async def on_progress(applied: int, total: int, state: str = "running") -> None:
        seen.append((applied, total, state))

    calls = 0

    async def execute(_op: Any, _args: dict[str, Any], _key: str) -> ExecOutcome:
        nonlocal calls
        calls += 1
        # The limiter's own message, surfaced by invoke_tool when a bulk write IS throttled.
        if 30 <= calls < 60:
            return ExecOutcome(
                status="failed", error="The assistant is busy — please try again shortly."
            )
        return ExecOutcome(status="applied", data={"movieId": "m"})

    await _apply(_bulk_proposal(120), execute=execute, on_progress=on_progress)

    states = [state for _a, _t, state in seen]
    assert "waiting" in states, (
        f"a throttled run never reported waiting — the member sees a stalled number: {states}"
    )
    assert states[-1] == "running", "the run finished, so the last report must not say waiting"
