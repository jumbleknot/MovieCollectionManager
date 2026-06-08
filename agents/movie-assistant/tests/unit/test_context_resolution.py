"""US3 (T054): context-aware "this"/current-screen target resolution.

A signed-in user viewing a collection says "add \<movie\> to this" — the organizer resolves
the target from the sanitized `ui_snapshot` (current screen + collection id) instead of a
named collection, then proceeds through the normal HITL approval flow (US3-AC1). An
unresolvable reference (no on-screen collection) asks the user to clarify rather than guessing
(US3-AC2 / FR-014).

Resolution is PURE CODE — `references_current_screen` is a keyword check (not an LLM call, so
no golden re-record, per T069g) and `_resolve_current_collection` matches the snapshot's
`collection_id` against the user's collections. The `ui_snapshot` reaches the node from
`config["configurable"]` via the BFF→gateway header bridge (R15); these unit tests pass it
directly in the node state.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, HumanMessage

from src.nodes.organizer import (
    _resolve_current_collection,
    build_organizer,
    references_current_screen,
)
from src.proposals import CollectionRef, EnrichedMovieCandidate, Operation

_CANDIDATE = EnrichedMovieCandidate(source_id="tmdb:603", title="The Matrix", year=1999)
_SCI_FI_ID = "0123456789abcdef01234567"
_CLASSICS_ID = "abcdef0123456789abcdef01"
_COLLECTIONS = [
    {"collectionId": _SCI_FI_ID, "name": "Sci-Fi", "movieCount": 3},
    {"collectionId": _CLASSICS_ID, "name": "Classics", "movieCount": 7},
]


def _organizer(collections: list[dict[str, Any]]) -> Any:
    async def list_collections() -> list[dict[str, Any]]:
        return collections

    return build_organizer(list_collections=list_collections, gen_id=lambda: "p1")


def _state(
    *,
    message: str,
    target: str = "",
    ui_snapshot: dict[str, Any] | None = None,
    candidate: EnrichedMovieCandidate | None = _CANDIDATE,
) -> dict[str, Any]:
    return {
        "messages": [HumanMessage(content=message)],
        "candidate": candidate,
        "target_collection_name": target,
        "ui_snapshot": ui_snapshot,
        "thread_id": "t1",
    }


# ── references_current_screen: the pure "this"/current keyword detector ──────────────────────


def test_references_current_screen_true_cases() -> None:
    for text in (
        "add The Matrix to this",
        "add this",
        "put it in this collection",
        "add The Matrix here",
        "add it to the current collection",
    ):
        assert references_current_screen(text), text


def test_references_current_screen_false_cases() -> None:
    for text in (
        "add The Matrix to Sci-Fi",
        "the first one",          # a disambiguation pick — not a current-screen reference
        "add The Matrix to my collection",
        "where is my movie",      # 'where' must not match 'here'
        "is there a sci-fi list",  # 'there' must not match 'here'
    ):
        assert not references_current_screen(text), text


# ── _resolve_current_collection: snapshot id → CollectionRef ─────────────────────────────────


def test_resolve_current_collection_on_collection_screen() -> None:
    ui = {"current_screen": "collection", "collection_id": _SCI_FI_ID}
    ref = _resolve_current_collection(ui, _COLLECTIONS)
    assert isinstance(ref, CollectionRef)
    assert ref.collection_id == _SCI_FI_ID and ref.name == "Sci-Fi"
    assert ref.create_if_missing is False


def test_resolve_current_collection_on_movie_detail_screen() -> None:
    # movie-detail is nested under a collection — "this" still means the containing collection.
    ui = {"current_screen": "movie-detail", "collection_id": _CLASSICS_ID, "movie_id": "m1"}
    ref = _resolve_current_collection(ui, _COLLECTIONS)
    assert ref is not None and ref.collection_id == _CLASSICS_ID


def test_resolve_current_collection_unresolvable_returns_none() -> None:
    home = {"current_screen": "home", "collection_id": None}
    drifted = {"current_screen": "collection", "collection_id": "ffffffffffffffffffffffff"}
    assert _resolve_current_collection(home, _COLLECTIONS) is None
    assert _resolve_current_collection({"current_screen": "profile"}, _COLLECTIONS) is None
    assert _resolve_current_collection(drifted, _COLLECTIONS) is None  # foreign / drifted id
    assert _resolve_current_collection(None, _COLLECTIONS) is None


# ── organizer end-to-end: "add X to this" resolves the on-screen collection (US3-AC1) ────────


async def test_add_to_this_resolves_current_collection() -> None:
    node = _organizer(_COLLECTIONS)
    out = await node(
        _state(
            message="add The Matrix to this",
            ui_snapshot={"current_screen": "collection", "collection_id": _SCI_FI_ID},
        )
    )
    proposal = out["pending_proposal"]
    assert proposal is not None
    assert proposal.target_collection.collection_id == _SCI_FI_ID
    assert proposal.target_collection.create_if_missing is False  # never creates "this"
    assert len(proposal.items) == 1 and proposal.items[0].operation == Operation.add
    assert out["status"] == "awaiting_approval"


async def test_add_to_this_on_home_clarifies(  # US3-AC2 / FR-014: never guess
) -> None:
    node = _organizer(_COLLECTIONS)
    out = await node(
        _state(
            message="add The Matrix to this",
            ui_snapshot={"current_screen": "home", "collection_id": None},
        )
    )
    assert out.get("pending_proposal") is None
    assert out["messages"]  # asks the user to clarify which collection
    assert isinstance(out["messages"][-1], AIMessage)


async def test_named_target_overrides_current_screen() -> None:
    # An explicitly named collection wins over the on-screen one (the user was specific).
    node = _organizer(_COLLECTIONS)
    out = await node(
        _state(
            message="add The Matrix to Classics",
            target="Classics",
            ui_snapshot={"current_screen": "collection", "collection_id": _SCI_FI_ID},
        )
    )
    assert out["pending_proposal"].target_collection.collection_id == _CLASSICS_ID


async def test_llm_extracted_this_as_collection_resolves_current_not_creates() -> None:
    # The curator sometimes extracts collection="this" from "add X to this" — that must resolve
    # the on-screen collection, NOT create a literal "this" collection (no create_if_missing).
    node = _organizer(_COLLECTIONS)
    out = await node(
        _state(
            message="add The Matrix to this",
            target="this",  # the LLM returned "this" as the collection name
            ui_snapshot={"current_screen": "collection", "collection_id": _SCI_FI_ID},
        )
    )
    proposal = out["pending_proposal"]
    assert proposal is not None
    assert proposal.target_collection.collection_id == _SCI_FI_ID
    assert proposal.target_collection.create_if_missing is False
    assert [i for i in proposal.items if i.operation == Operation.create_collection] == []


async def test_this_with_drifted_snapshot_clarifies() -> None:
    node = _organizer(_COLLECTIONS)
    drifted = {"current_screen": "collection", "collection_id": "ffffffffffffffffffffffff"}
    out = await node(_state(message="add The Matrix to this", ui_snapshot=drifted))
    assert out.get("pending_proposal") is None
    assert out["messages"]
