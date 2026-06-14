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

    msg = _import_summary_message(result)
    assert "1 could not be imported" in msg
    assert "Heat" in msg and "422 invalid value" in msg  # which + why


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
