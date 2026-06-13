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

from src.nodes.organizer import _resolve_op_movie, build_organizer
from src.proposals import EnrichedMovieCandidate, Operation, ProposalKind

# ── New bug 1 (013 Inc5): partial-title resolution for organize ops ──────────────────────────
_OP_MOVIES = [
    {"movieId": "m1", "title": "Harry Potter and the Order of the Phoenix", "year": 2007},
    {"movieId": "m2", "title": "Harry Potter and the Goblet of Fire", "year": 2005},
    {"movieId": "m3", "title": "Coherence", "year": 2013},
    {"movieId": "m4", "title": "Primer"},  # no year — must still resolve
]


def test_resolve_op_movie_exact_title_year() -> None:
    kind, payload = _resolve_op_movie("Coherence", _OP_MOVIES)
    assert kind == "one" and payload["movieId"] == "m3"


def test_resolve_op_movie_partial_unique_resolves() -> None:
    # The reported case: one "Harry Potter…" in the collection → a partial name resolves it.
    kind, payload = _resolve_op_movie("coherenc", _OP_MOVIES)
    assert kind == "one" and payload["movieId"] == "m3"


def test_resolve_op_movie_partial_multiple_is_ambiguous() -> None:
    kind, payload = _resolve_op_movie("harry potter", _OP_MOVIES)
    assert kind == "many"
    assert {m["movieId"] for m in payload} == {"m1", "m2"}


def test_resolve_op_movie_partial_with_year_disambiguates() -> None:
    kind, payload = _resolve_op_movie("harry potter (2005)", _OP_MOVIES)
    assert kind == "one" and payload["movieId"] == "m2"


def test_resolve_op_movie_no_year_title_resolves() -> None:
    kind, payload = _resolve_op_movie("Primer", _OP_MOVIES)
    assert kind == "one" and payload["movieId"] == "m4"


def test_resolve_op_movie_no_match_is_none() -> None:
    kind, payload = _resolve_op_movie("nonexistent film", _OP_MOVIES)
    assert kind == "none" and payload is None


def test_resolve_op_movie_too_short_partial_does_not_match_everything() -> None:
    kind, _ = _resolve_op_movie("a", _OP_MOVIES)
    assert kind == "none"


def test_resolve_op_movie_named_year_absent_is_no_match() -> None:
    # The user named a year no candidate has → a miss, never a different-year film (parity with
    # the exact (title, year) rule).
    kind, payload = _resolve_op_movie("Coherence (2099)", _OP_MOVIES)
    assert kind == "none" and payload is None

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


async def test_existing_collection_preview_reads_add_movie_to_collection() -> None:
    # T073: an existing-collection add puts the movie first — no awkward double-"add".
    node = _organizer(_EXISTING)
    out = await node(_state("Sci-Fi"))
    content = out["messages"][-1].content
    assert content == 'Ready to add The Matrix (1999) to "Sci-Fi". Approve to apply.'
    assert "add to" not in content  # the old double-"add" phrasing is gone


async def test_create_if_missing_preview_names_the_new_collection_first() -> None:
    # T073: a create-if-missing target keeps "create X and add …" (the movie isn't there yet).
    node = _organizer([])
    out = await node(_state("Brand New"))
    content = out["messages"][-1].content
    assert content == 'Ready to create "Brand New" and add The Matrix (1999). Approve to apply.'


async def test_unnamed_target_resolves_to_default_collection_not_a_literal_name() -> None:
    # T073/T069c verification: an unnamed/generic target resolves to the user's real DEFAULT
    # collection (FR-005b), NOT a create-if-missing of a literal "Movie Collection".
    default = [
        {"collectionId": "0123456789abcdef01234567", "name": "My Movies", "isDefault": True},
    ]
    node = _organizer(default)
    out = await node(_state(""))  # no collection named
    proposal = out["pending_proposal"]
    assert proposal.target_collection.create_if_missing is False
    assert proposal.target_collection.collection_id == "0123456789abcdef01234567"
    assert out["messages"][-1].content == (
        'Ready to add The Matrix (1999) to "My Movies". Approve to apply.'
    )


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
