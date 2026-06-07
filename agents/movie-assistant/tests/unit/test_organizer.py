"""Unit tests for the organizer add path (T041, US1).

The organizer turns the curator's EnrichedMovieCandidate + a target collection into an
HITL-gated Proposal — it does NOT write here (writes happen on the approved-resume path,
Slice E). Code-orchestrated (decided 2026-06-07): the organizer resolves the target with a
`list_collections` READ and builds the proposal in code via `build_add_proposal`; the LLM
never selects tools or generates write args. Create-if-missing surfaces both writes in one
proposal (FR-005a/FR-006). Target matching is case-insensitive (mc-service collation parity).
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import HumanMessage

from src.nodes.organizer import build_organizer
from src.proposals import EnrichedMovieCandidate, Operation, ProposalKind

_CANDIDATE = EnrichedMovieCandidate(source_id="tmdb:603", title="The Matrix", year=1999)
_EXISTING = [{"collectionId": "0123456789abcdef01234567", "name": "Sci-Fi", "movieCount": 3}]


def _state(target: str, candidate: EnrichedMovieCandidate | None = _CANDIDATE) -> dict[str, Any]:
    return {
        "messages": [HumanMessage(content=f"add The Matrix to {target}")],
        "candidate": candidate,
        "target_collection_name": target,
        "thread_id": "t1",
    }


def _organizer(collections: list[dict[str, Any]]) -> Any:
    async def list_collections() -> list[dict[str, Any]]:
        return collections

    return build_organizer(list_collections=list_collections, gen_id=lambda: "p1")


async def test_add_to_existing_collection_builds_single_add_proposal() -> None:
    node = _organizer(_EXISTING)
    out = await node(_state("Sci-Fi"))

    proposal = out["pending_proposal"]
    assert proposal.kind == ProposalKind.add_movie
    assert proposal.target_collection.collection_id == "0123456789abcdef01234567"
    assert proposal.target_collection.create_if_missing is False
    assert len(proposal.items) == 1
    assert proposal.items[0].operation == Operation.add
    assert out["status"] == "awaiting_approval"


async def test_add_to_missing_collection_surfaces_create_plus_add() -> None:
    node = _organizer([])  # no collections → create-if-missing
    out = await node(_state("Brand New"))

    proposal = out["pending_proposal"]
    assert proposal.kind == ProposalKind.batch
    assert proposal.target_collection.create_if_missing is True
    assert proposal.target_collection.name == "Brand New"
    ops = {i.operation for i in proposal.items}
    assert ops == {Operation.create_collection, Operation.add}


async def test_target_match_is_case_insensitive() -> None:
    node = _organizer(_EXISTING)
    out = await node(_state("sci-fi"))  # lower-case request matches "Sci-Fi"

    proposal = out["pending_proposal"]
    assert proposal.target_collection.collection_id == "0123456789abcdef01234567"
    assert proposal.target_collection.create_if_missing is False


async def test_no_candidate_yields_no_proposal() -> None:
    node = _organizer(_EXISTING)
    out = await node(_state("Sci-Fi", candidate=None))

    assert out.get("pending_proposal") is None
    assert out["messages"]  # a graceful message instead of a proposal


async def test_proposal_items_carry_deterministic_idempotency_keys() -> None:
    node = _organizer([])
    out = await node(_state("Brand New"))
    keys = [i.idempotency_key for i in out["pending_proposal"].items]
    assert all(keys) and len(set(keys)) == len(keys)  # present + distinct per item
