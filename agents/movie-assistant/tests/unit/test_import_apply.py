"""T034 (apply path): an import create applies via Operation.add carrying a RAW movie_payload.

US1-add/US2-organize items carry an EnrichedMovieCandidate; an import create instead carries a
fully-composed `movie_payload` (no TMDB candidate). apply_proposal's add branch must use the raw
payload when there is no candidate — without re-deriving it — so import creates reuse the exact
same HITL gate + idempotency-keyed at-most-once apply. The candidate path is unchanged.
"""

from __future__ import annotations

from typing import Any

from src.nodes.approval_gate import ExecOutcome, apply_proposal
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
