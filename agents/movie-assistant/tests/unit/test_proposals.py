"""Unit tests for proposal assembly + idempotency (T041, US1).

Data-model: specs/012-multi-agent-mvp/data-model.md (Proposal / ProposalItem /
EnrichedMovieCandidate). Pure builders — no LLM/network.

- Idempotency key = hash(thread_id, proposal_id, item_id) → at-most-once apply
  (FR-009, SC-006): deterministic, distinct per item AND per proposal/thread.
- build_add_proposal: an add to an existing collection is one item; an add whose target
  collection doesn't exist surfaces BOTH the create-collection and the movie add in the
  SAME proposal (FR-005a / FR-006 — one preview).
- EnrichedMovieCandidate validates the web-api-mcp camelCase output and round-trips.
"""

from __future__ import annotations

from src.proposals import (
    CollectionRef,
    EnrichedMovieCandidate,
    Operation,
    Proposal,
    ProposalKind,
    build_add_proposal,
    idempotency_key,
)

_CANDIDATE = EnrichedMovieCandidate(
    source="tmdb",
    source_id="tmdb:603",
    title="The Matrix",
    year=1999,
    genres=["Science Fiction"],
)


# ── idempotency key ──────────────────────────────────────────────────────────

def test_idempotency_key_is_deterministic() -> None:
    a = idempotency_key("t1", "p1", "i1")
    b = idempotency_key("t1", "p1", "i1")
    assert a == b and len(a) > 0


def test_idempotency_key_differs_per_item_proposal_and_thread() -> None:
    base = idempotency_key("t1", "p1", "i1")
    assert idempotency_key("t1", "p1", "i2") != base  # different item
    assert idempotency_key("t1", "p2", "i1") != base  # different proposal
    assert idempotency_key("t2", "p1", "i1") != base  # different thread


# ── EnrichedMovieCandidate (camelCase wire ↔ snake_case model) ────────────────

def test_candidate_validates_web_api_mcp_camelcase_output() -> None:
    wire = {
        "source": "tmdb",
        "sourceId": "tmdb:603",
        "title": "The Matrix",
        "year": 1999,
        "overview": "A hacker learns the truth.",
        "genres": ["Science Fiction"],
        "posterUrl": "https://image.tmdb.org/x.jpg",
        "language": "English",
    }
    cand = EnrichedMovieCandidate.model_validate(wire)
    assert cand.source_id == "tmdb:603"
    assert cand.poster_url == "https://image.tmdb.org/x.jpg"
    # Round-trips back to the camelCase wire shape.
    assert cand.model_dump(by_alias=True)["sourceId"] == "tmdb:603"


# ── build_add_proposal ───────────────────────────────────────────────────────

def test_add_to_existing_collection_is_single_add_item() -> None:
    proposal = build_add_proposal(
        thread_id="t1",
        proposal_id="p1",
        candidate=_CANDIDATE,
        target=CollectionRef(collection_id="0123456789abcdef01234567", name="Sci-Fi"),
    )
    assert isinstance(proposal, Proposal)
    assert proposal.kind == ProposalKind.add_movie
    assert len(proposal.items) == 1
    item = proposal.items[0]
    assert item.operation == Operation.add
    assert item.movie_candidate is not None and item.movie_candidate.title == "The Matrix"
    assert item.idempotency_key == idempotency_key("t1", "p1", item.item_id)


def test_create_if_missing_surfaces_both_writes_in_one_proposal() -> None:
    proposal = build_add_proposal(
        thread_id="t1",
        proposal_id="p2",
        candidate=_CANDIDATE,
        target=CollectionRef(name="Brand New", create_if_missing=True),
    )
    assert proposal.kind == ProposalKind.batch  # two writes → batch preview
    ops = [i.operation for i in proposal.items]
    assert Operation.create_collection in ops
    assert Operation.add in ops
    # Distinct idempotency keys per item.
    keys = {i.idempotency_key for i in proposal.items}
    assert len(keys) == len(proposal.items)


def test_all_items_carry_pending_status_and_no_revalidation_yet() -> None:
    proposal = build_add_proposal(
        thread_id="t1",
        proposal_id="p3",
        candidate=_CANDIDATE,
        target=CollectionRef(collection_id="0123456789abcdef01234567", name="Sci-Fi"),
    )
    assert proposal.status == "pending"
    assert all(i.revalidation is None for i in proposal.items)
