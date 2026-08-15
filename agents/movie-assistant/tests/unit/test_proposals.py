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
    BATCH_CAP,
    CollectionRef,
    EnrichedMovieCandidate,
    Operation,
    OrganizeOp,
    Proposal,
    ProposalKind,
    build_add_proposal,
    build_organize_proposal,
    chunk_operations,
    compose_movie_payload,
    idempotency_key,
    to_movie_payload,
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


# ── to_movie_payload TMDB external link (013 US5 / T041) ──────────────────────

def test_to_movie_payload_sets_tmdb_external_id_url() -> None:
    payload = to_movie_payload(_CANDIDATE)
    ext = payload["externalIds"]
    assert ext == [
        {
            "system": "tmdb",
            "uniqueId": "603",
            "url": "https://www.themoviedb.org/movie/603",
        }
    ]


def test_to_movie_payload_omits_external_id_when_no_usable_id() -> None:
    # No id after the "tmdb:" prefix → no externalIds entry, and crucially no malformed url.
    candidate = EnrichedMovieCandidate(source="tmdb", source_id="tmdb", title="Mystery")
    assert to_movie_payload(candidate)["externalIds"] == []


# ── 040 US4: ownership comes from the user's answer, not a forced default ──────

def test_to_movie_payload_owned_defaults_false_not_forced_true() -> None:
    # The old behavior hardcoded owned=True. Default is now False (matches mc-service's default),
    # so an omitted answer is never silently "owned".
    assert to_movie_payload(_CANDIDATE)["owned"] is False


def test_to_movie_payload_owned_reflects_the_answer() -> None:
    assert to_movie_payload(_CANDIDATE, owned=True)["owned"] is True
    assert to_movie_payload(_CANDIDATE, owned=False)["owned"] is False


def test_build_add_proposal_threads_owned_onto_the_add_item() -> None:
    # "No" still produces an add to the chosen collection, just with owned=False (FR-010).
    from src.proposals import CollectionRef, Operation, build_add_proposal

    proposal = build_add_proposal(
        thread_id="t1",
        proposal_id="p1",
        candidate=_CANDIDATE,
        target=CollectionRef(collection_id="c1", name="Sci-Fi"),
        owned=False,
    )
    add_item = next(i for i in proposal.items if i.operation == Operation.add)
    assert add_item.owned is False
    assert proposal.target_collection.collection_id == "c1"  # membership independent of ownership


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


# ── chunk_operations (FR-009b batch cap) ──────────────────────────────────────

def _remove_op(movie_id: str) -> OrganizeOp:
    return OrganizeOp(operation=Operation.remove, collection_id="c1", movie_id=movie_id)


def test_chunk_splits_oversized_plan_into_sequential_batches() -> None:
    ops = [_remove_op(f"m{i}") for i in range(BATCH_CAP * 2 + 3)]  # 103 with cap 50
    batches = chunk_operations(ops)
    assert [len(b) for b in batches] == [BATCH_CAP, BATCH_CAP, 3]
    # No operation is lost or duplicated across the split.
    flat = [op.movie_id for b in batches for op in b]
    assert flat == [op.movie_id for op in ops]


def test_chunk_within_cap_is_one_batch_and_empty_is_none() -> None:
    assert len(chunk_operations([_remove_op("m1"), _remove_op("m2")])) == 1
    assert chunk_operations([]) == []


def test_chunk_rejects_nonpositive_cap() -> None:
    import pytest

    with pytest.raises(ValueError):
        chunk_operations([_remove_op("m1")], cap=0)


# ── build_organize_proposal (update / remove batch) ───────────────────────────

def test_organize_proposal_builds_typed_items_with_distinct_keys() -> None:
    ops = [
        OrganizeOp(operation=Operation.remove, collection_id="c1", movie_id="mA", label="Old A"),
        OrganizeOp(
            operation=Operation.update,
            collection_id="c1",
            movie_id="mB",
            movie_payload={"title": "B", "rated": "PG-13"},
            label="B",
        ),
    ]
    proposal = build_organize_proposal(thread_id="t1", proposal_id="p1", operations=ops)
    assert proposal.kind == ProposalKind.batch
    assert proposal.target_collection is None  # an organize batch may span collections
    remove, update = proposal.items
    assert remove.operation == Operation.remove
    assert remove.movie_ref == {"collectionId": "c1", "movieId": "mA"}
    assert update.operation == Operation.update
    assert update.movie_payload == {"title": "B", "rated": "PG-13"}
    # Deterministic, distinct at-most-once keys (FR-009/SC-006).
    assert remove.idempotency_key == idempotency_key("t1", "p1", remove.item_id)
    assert remove.idempotency_key != update.idempotency_key


def test_single_organize_op_gets_a_specific_kind() -> None:
    proposal = build_organize_proposal(
        thread_id="t1", proposal_id="p1", operations=[_remove_op("mA")]
    )
    assert proposal.kind == ProposalKind.delete_movie
    assert len(proposal.items) == 1


def test_organize_proposal_carries_batch_index_and_total() -> None:
    proposal = build_organize_proposal(
        thread_id="t1",
        proposal_id="p2",
        operations=[_remove_op("mA")],
        batch_index=1,
        batch_total=3,
    )
    assert proposal.batch_index == 1
    assert proposal.batch_total == 3


# ── compose_movie_payload (full-replace payload for update / move — T070a) ─────

_MOVIE_DOC = {
    "movieId": "m2",
    "collectionId": "c1",
    "_id": "deadbeef",
    "id": "ignored",
    "title": "Inception",
    "year": 2010,
    "owned": False,
    "ripped": False,
    "childrens": False,
    "tags": ["scifi"],
    "genres": ["Science Fiction"],
    "rated": "PG-13",
}


def test_compose_movie_payload_strips_id_fields() -> None:
    # The PUT/POST payload is the movie sans its server-assigned ids (mc-service rejects
    # an embedded movieId/_id on a full-replace).
    payload = compose_movie_payload(_MOVIE_DOC)
    for stripped in ("movieId", "collectionId", "_id", "id"):
        assert stripped not in payload
    # Non-id fields survive unchanged (round-trips the document we read).
    assert payload["title"] == "Inception"
    assert payload["genres"] == ["Science Fiction"]
    assert payload["rated"] == "PG-13"


def test_compose_movie_payload_overlays_boolean_flags() -> None:
    payload = compose_movie_payload(_MOVIE_DOC, {"owned": True, "childrens": True})
    assert payload["owned"] is True
    assert payload["childrens"] is True
    assert payload["ripped"] is False  # untouched flag keeps its read value


def test_compose_movie_payload_adds_and_removes_tags() -> None:
    payload = compose_movie_payload(
        _MOVIE_DOC, {"addTags": ["favorite", "scifi"], "removeTags": []}
    )
    # add is a set-union preserving order; an already-present tag is not duplicated.
    assert payload["tags"] == ["scifi", "favorite"]

    removed = compose_movie_payload(_MOVIE_DOC, {"removeTags": ["scifi"]})
    assert removed["tags"] == []


def test_compose_movie_payload_does_not_mutate_the_source_doc() -> None:
    compose_movie_payload(_MOVIE_DOC, {"owned": True, "addTags": ["x"]})
    assert _MOVIE_DOC["owned"] is False  # original read is untouched
    assert _MOVIE_DOC["tags"] == ["scifi"]


# ── build_organize_proposal: move item (T070a) ────────────────────────────────

def test_move_op_item_carries_source_dest_and_replacement_payload() -> None:
    move = OrganizeOp(
        operation=Operation.move,
        collection_id="c1",            # source
        movie_id="mX",
        dest_collection_id="c2",       # destination
        movie_payload={"title": "Inception", "owned": True},
        label="Inception",
    )
    proposal = build_organize_proposal(thread_id="t1", proposal_id="pm", operations=[move])
    assert proposal.kind == ProposalKind.move_movie  # single move → specific kind
    item = proposal.items[0]
    assert item.operation == Operation.move
    assert item.movie_ref == {
        "collectionId": "c1",
        "movieId": "mX",
        "destCollectionId": "c2",
    }
    assert item.movie_payload == {"title": "Inception", "owned": True}


# ── 047 US4 (T076, FR-025/FR-026/FR-027): ownership fields reach the payload ─────────────────
#
# to_movie_payload hardcoded `ownedMedia: []`, `ripped: False` and `ripQuality: []`, so the
# member's answers had nowhere to go. They become parameters.
#
# The cross-field rules (formats only when owned, qualities only when ripped) are enforced by
# mc-service's OwnedMediaWhenOwnedSpec / RipQualityWhenRippedSpec. The agent must NOT
# re-implement them (FR-027, and the constitution's No Domain Logic in Agents) — what it must
# do is not SEND values the member did not give, which is what these pin.


def _ownership_candidate() -> EnrichedMovieCandidate:
    return EnrichedMovieCandidate(
        sourceId="tmdb:603",
        title="The Matrix",
        year=1999,
        overview="A hacker learns the truth.",
        genres=["Action"],
        posterUrl=None,
    )


def test_ownership_fields_carry_the_chosen_values() -> None:
    payload = to_movie_payload(
        _ownership_candidate(),
        owned=True,
        owned_media=["DVD", "Blu-Ray"],
        ripped=True,
        rip_quality=["UHD Blu-Ray"],
    )
    assert payload["owned"] is True
    assert payload["ownedMedia"] == ["DVD", "Blu-Ray"]
    assert payload["ripped"] is True
    assert payload["ripQuality"] == ["UHD Blu-Ray"]


def test_ownership_fields_empty_owned_media_when_not_owned() -> None:
    """An unowned movie carries no formats — mc-service would reject them (OwnedMediaWhenOwnedSpec).

    The agent does not RE-VALIDATE that rule; it simply never sends what the member could not
    have chosen, because the format question is not asked when the answer to "do you own it"
    was no.
    """
    payload = to_movie_payload(
        _ownership_candidate(),
        owned=False,
        owned_media=["DVD"],
        ripped=False,
        rip_quality=[],
    )
    assert payload["owned"] is False
    assert payload["ownedMedia"] == []


def test_ownership_fields_empty_rip_quality_when_not_ripped() -> None:
    """FR-026: qualities are only meaningful on a ripped movie (RipQualityWhenRippedSpec)."""
    payload = to_movie_payload(
        _ownership_candidate(),
        owned=True,
        owned_media=["DVD"],
        ripped=False,
        rip_quality=["UHD Blu-Ray"],
    )
    assert payload["ripped"] is False
    assert payload["ripQuality"] == []


def test_ownership_fields_default_to_the_previous_behaviour() -> None:
    """Omitting the new parameters must reproduce exactly what the payload did before.

    Every existing caller (import, organize) relies on this, so the change stays additive.
    """
    payload = to_movie_payload(_ownership_candidate())
    assert payload["owned"] is False
    assert payload["ownedMedia"] == []
    assert payload["ripped"] is False
    assert payload["ripQuality"] == []


def test_ownership_fields_do_not_alias_the_caller_list() -> None:
    """The payload must not hand back the caller's list object — a later mutation would leak."""
    formats = ["DVD"]
    payload = to_movie_payload(
        _ownership_candidate(), owned=True, owned_media=formats, ripped=False, rip_quality=[]
    )
    formats.append("Blu-Ray")
    assert payload["ownedMedia"] == ["DVD"]


def test_ownership_fields_survive_the_proposal_round_trip() -> None:
    """build_add_proposal → ProposalItem → to_movie_payload keeps the member's answers.

    The gate applies the write from the ProposalItem, so a value that reaches the payload
    builder but not the item is a value the member chose and never got.
    """
    proposal = build_add_proposal(
        thread_id="t1",
        proposal_id="p1",
        candidate=_ownership_candidate(),
        target=CollectionRef(collection_id="c1", name="Favourites"),
        owned=True,
        owned_media=["Blu-Ray 3D"],
        ripped=True,
        rip_quality=["DVD"],
    )
    item = next(i for i in proposal.items if i.operation is Operation.add)
    assert item.owned is True
    assert item.owned_media == ["Blu-Ray 3D"]
    assert item.ripped is True
    assert item.rip_quality == ["DVD"]

    payload = to_movie_payload(
        _ownership_candidate(),
        owned=bool(item.owned),
        owned_media=item.owned_media,
        ripped=bool(item.ripped),
        rip_quality=item.rip_quality,
    )
    assert payload["ownedMedia"] == ["Blu-Ray 3D"]
    assert payload["ripQuality"] == ["DVD"]


# ---------------------------------------------------------------------------
# 059 T005 (FR-007 / FR-015 / SC-007): characterization guard for the callers
# this feature must NOT disturb.
#
# This is a GUARD, not a RED/GREEN pair — it passes before the change and must still pass
# after. `to_movie_payload` is shared by the add path (which 059 rewires), the spreadsheet
# import and the conversational organize/update path (`compose_movie_payload`), and the two
# new parameters are defaulted precisely so the latter two keep today's behaviour. Without
# this, the first sign that a default was got wrong would be a member's imported library
# quietly acquiring an add-time rating it never had.


def test_compose_movie_payload_injects_neither_rated_nor_childrens() -> None:
    """The organize/update path composes from the STORED document — 059 adds nothing to it.

    A full-replacement update resends what mc-service already holds, overlaid with the
    member's requested changes. If the add path's new defaults ever leaked into this
    composer, every conversational update would silently rewrite the movie's rating.
    """
    stored = {
        "movieId": "m1",
        "collectionId": "c1",
        "title": "The Matrix",
        "rated": "R",
        "childrens": False,
        "tags": ["classic"],
    }

    unchanged = compose_movie_payload(stored)
    assert unchanged["rated"] == "R"  # preserved verbatim, not defaulted
    assert unchanged["childrens"] is False

    # A change to an unrelated field leaves both alone.
    tagged = compose_movie_payload(stored, {"addTags": ["sci-fi"]})
    assert tagged["rated"] == "R"
    assert tagged["childrens"] is False

    # And a document that carries NEITHER field does not acquire them here.
    minimal = compose_movie_payload({"movieId": "m2", "title": "Coherence"}, {"owned": True})
    assert "rated" not in minimal
    assert "childrens" not in minimal


# ---------------------------------------------------------------------------
# 059 US1 T009 (FR-004, research R5): the add payload carries the film's REAL rating.
#
# Before this feature `to_movie_payload` hardcoded "rated": "NR" — so every movie the
# assistant added claimed to be not-rated regardless of what it actually is. That is the
# reported defect (item #163): false data written into a member's library on every add.


def _rated_candidate(rated: str | None) -> EnrichedMovieCandidate:
    return EnrichedMovieCandidate(
        sourceId="tmdb:412117",
        title="The Secret Life of Pets 2",
        year=2019,
        genres=["Animation"],
        rated=rated,
    )


def test_payload_rated_carries_the_candidates_rating() -> None:
    assert to_movie_payload(_rated_candidate("PG"))["rated"] == "PG"


def test_payload_rated_never_substitutes_nr_when_unknown() -> None:
    """The old literal. `NR` is a CLAIM the film is not rated — only send it when told so."""
    payload = to_movie_payload(_rated_candidate(None))
    assert payload["rated"] is None
    assert payload["rated"] != "NR"


def test_payload_keeps_the_rated_key_present_when_null() -> None:
    """CreateMovieDto types `rated` Option<T> but without serde(default) — omit it and
    mc-service 422s the add (research R5, import_resolvers._CREATE_NULL_DEFAULTS)."""
    assert "rated" in to_movie_payload(_rated_candidate(None))


def test_payload_rated_passes_the_hyphenated_form_through() -> None:
    """No PG13/NC17 rename exists at any boundary (research R1, corrects item #163 AC3)."""
    assert to_movie_payload(_rated_candidate("PG-13"))["rated"] == "PG-13"
    assert to_movie_payload(_rated_candidate("NC-17"))["rated"] == "NC-17"


def test_candidate_without_rated_still_builds_a_payload() -> None:
    """`rated` is defaulted on the model, so the disambiguation path — which builds
    candidates from search results, with no details call — is unaffected."""
    bare = EnrichedMovieCandidate(sourceId="tmdb:603", title="The Matrix")
    assert bare.rated is None
    assert to_movie_payload(bare)["rated"] is None


def test_payload_rated_is_nr_when_the_source_says_nr() -> None:
    """FR-005: the value is not special-cased on the way through — only its origin changed."""
    assert to_movie_payload(_rated_candidate("NR"))["rated"] == "NR"


# ---------------------------------------------------------------------------
# 059 US2 T017/T019 (FR-010, FR-015, FR-016): the member's children's-movie answer.
#
# `"childrens": False` was hardcoded, so the field recorded the absence of a question
# rather than an answer. It now comes from the member — and must survive the approval
# pause, which means riding on the ProposalItem rather than on graph state alone.


def test_payload_childrens_carries_the_members_answer() -> None:
    assert to_movie_payload(_ownership_candidate(), childrens=True)["childrens"] is True


def test_payload_childrens_defaults_to_false() -> None:
    """FR-015: the default reproduces today's behaviour exactly, so the import and organize
    callers — which do not ask this question — are untouched."""
    assert to_movie_payload(_ownership_candidate())["childrens"] is False


def test_payload_childrens_false_is_sent_as_a_real_answer() -> None:
    assert to_movie_payload(_ownership_candidate(), childrens=False)["childrens"] is False


def test_proposal_item_childrens_survives_the_approval_pause() -> None:
    """The gate applies the write from the ProposalItem, so an answer that reaches the payload
    builder but not the item is an answer the member gave and never got (research R9)."""
    proposal = build_add_proposal(
        thread_id="t1",
        proposal_id="p1",
        candidate=_ownership_candidate(),
        target=CollectionRef(collection_id="c1", name="Favourites"),
        owned=False,
        childrens=True,
    )
    item = next(i for i in proposal.items if i.operation is Operation.add)
    assert item.childrens is True
    assert to_movie_payload(_ownership_candidate(), childrens=bool(item.childrens))["childrens"]


def test_proposal_item_childrens_defaults_to_none_when_never_asked() -> None:
    """None distinguishes "not asked" from "answered no" on the item; the payload still sends
    a concrete False, because mc-service's field is a bool."""
    proposal = build_add_proposal(
        thread_id="t1",
        proposal_id="p1",
        candidate=_ownership_candidate(),
        target=CollectionRef(collection_id="c1", name="Favourites"),
    )
    item = next(i for i in proposal.items if i.operation is Operation.add)
    assert item.childrens is None


def test_parity_add_and_update_paths_set_the_same_childrens_field() -> None:
    """FR-016 exists to stop the two paths drifting; without this nothing notices when they do.

    `compose_movie_payload` already accepts a `childrens` change (the conversational
    "mark this as a children's movie" path). This asserts the ADD path joins that vocabulary
    rather than inventing a second one — a `childrensMovie`/`isChildrens` key would pass every
    other test in this file and write a field mc-service ignores.
    """
    added = to_movie_payload(_ownership_candidate(), childrens=True)
    updated = compose_movie_payload(
        {"movieId": "m1", "title": "The Matrix", "childrens": False}, {"childrens": True}
    )

    assert added["childrens"] is True
    assert updated["childrens"] is True
    # The same KEY, not merely the same value.
    assert "childrens" in added and "childrens" in updated
    assert [k for k in added if "child" in k.lower()] == ["childrens"]
    assert [k for k in updated if "child" in k.lower()] == ["childrens"]
