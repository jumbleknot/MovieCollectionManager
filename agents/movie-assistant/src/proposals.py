"""Proposal assembly: idempotency keys, batch chunking, approval-time re-validation.

Implements: T041 (build + idempotency + create-if-missing), T050 (batch/chunk + re-validate).
Data-model: specs/012-multi-agent-mvp/data-model.md.

Idempotency key = sha256(thread_id, proposal_id, item_id) -> at-most-once apply
(FR-009/SC-006). Create-if-missing surfaces the create-collection AND the movie add in the
SAME proposal (FR-005a/FR-006 — one preview). Batch cap ~50 + approval-time re-validation
(skip now-duplicate/now-missing, apply valid, never abort) land with US2 (T050).
"""

from __future__ import annotations

import hashlib
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class MatchConfidence(StrEnum):
    """How confident the external lookup is about the match (offer-options edge case)."""

    exact = "exact"
    ambiguous = "ambiguous"
    none = "none"


class Operation(StrEnum):
    add = "add"
    update = "update"
    remove = "remove"
    # Cross-collection move (US2/T070). Applied as a guarded add-to-dest then remove-from-source
    # so a failed add never loses the movie; carries both the source ref and dest_collection_id.
    move = "move"
    create_collection = "create_collection"


class ProposalKind(StrEnum):
    add_movie = "add_movie"
    update_movie = "update_movie"
    delete_movie = "delete_movie"
    move_movie = "move_movie"
    create_collection = "create_collection"
    batch = "batch"


class Revalidation(StrEnum):
    valid = "valid"
    skipped_duplicate = "skipped_duplicate"
    skipped_missing = "skipped_missing"


class EnrichedMovieCandidate(BaseModel):
    """Read-only TMDB metadata for a preview; validates web-api-mcp's camelCase output.

    Snake_case attributes with camelCase aliases so `model_validate(<tool output>)` works
    and `model_dump(by_alias=True)` reproduces the wire shape. Not persisted unless approved.
    """

    model_config = ConfigDict(populate_by_name=True)

    source: str = "tmdb"
    source_id: str = Field(alias="sourceId")
    title: str
    year: int | None = None
    overview: str = ""
    genres: list[str] = Field(default_factory=list)
    poster_url: str | None = Field(default=None, alias="posterUrl")
    language: str | None = None
    match_confidence: MatchConfidence | None = Field(default=None, alias="matchConfidence")


class CollectionRef(BaseModel):
    """A target collection: an existing one (collection_id) or one to create (create_if_missing)."""

    collection_id: str | None = None
    name: str | None = None
    create_if_missing: bool = False


class ProposalItem(BaseModel):
    """One reviewable change within a proposal; each carries its own idempotency key."""

    item_id: str
    operation: Operation
    movie_candidate: EnrichedMovieCandidate | None = None
    movie_ref: dict[str, Any] | None = None
    # Full replacement payload for an `update` (mc-service PUT is full-replace); the organizer
    # composes it from a read + the requested changes. None for add/remove/create.
    movie_payload: dict[str, Any] | None = None
    diff: dict[str, Any] = Field(default_factory=dict)
    revalidation: Revalidation | None = None
    idempotency_key: str


class Proposal(BaseModel):
    """A concrete change (or batch) awaiting approval; lives in GraphState.pending_proposal."""

    proposal_id: str
    kind: ProposalKind
    items: list[ProposalItem]
    target_collection: CollectionRef | None = None
    status: str = "pending"
    batch_index: int = 0
    batch_total: int = 1
    created_in_segment: str = ""


# Max items per batch proposal (FR-009b); an oversized organize request is split into
# sequential batches, each independently previewed and approved.
BATCH_CAP = 50


class OrganizeOp(BaseModel):
    """One planned organize operation (US2). The LLM produces the typed plan; CODE turns it
    into proposal items + drives the writes (code-orchestration decision) — the model never
    selects tools or forges payloads. `collection_id` is the source (update/remove/move) or
    destination (add). `dest_collection_id` is the move destination. `movie_payload` is the FULL
    replacement payload for an update or the re-add payload for a move (mc-service is
    full-replace)."""

    operation: Operation  # add | update | remove | move
    collection_id: str
    movie_id: str | None = None
    dest_collection_id: str | None = None
    movie_payload: dict[str, Any] | None = None
    movie_candidate: EnrichedMovieCandidate | None = None
    label: str = ""


def idempotency_key(thread_id: str, proposal_id: str, item_id: str) -> str:
    """Deterministic at-most-once key for a write item (FR-009/SC-006)."""
    raw = f"{thread_id}:{proposal_id}:{item_id}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def to_movie_payload(candidate: EnrichedMovieCandidate) -> dict[str, Any]:
    """Shape an EnrichedMovieCandidate into the mc-service add-movie payload (FR-022).

    Enriched fields fill what TMDB gives us; the rest take sensible add-time defaults (the
    movie is being added to the user's own collection). The TMDB provenance is preserved as
    an `externalIds` entry (`source_id` "tmdb:603" → {source: "tmdb", id: "603"}). mc-service
    validates/persists; this introduces no domain logic.
    """
    source, _, external_id = candidate.source_id.partition(":")
    # mc-service ExternalIdentifier shape: { system, uniqueId, url? } (camelCase). Using
    # source/id was a real defect — mc-service rejected the add with 422 (caught in T036).
    external_ids = [{"system": source, "uniqueId": external_id}] if external_id else []
    return {
        "title": candidate.title,
        "year": candidate.year,
        "contentType": "Movie",
        "language": candidate.language or "English",
        "owned": True,
        "ripped": False,
        "childrens": False,
        "ownedMedia": [],
        "ripQuality": [],
        "genres": list(candidate.genres),
        "rated": "NR",
        "directors": [],
        "actors": [],
        "tags": [],
        "movieSet": None,
        "originalTitle": None,
        "releaseDate": None,
        "outline": None,
        "plot": candidate.overview or None,
        "runtime": None,
        "externalIds": external_ids,
    }


# Server-assigned identifiers stripped from a movie document before it is sent back as a
# full-replacement payload (mc-service rejects an embedded movieId/_id on a PUT/POST).
_MOVIE_ID_FIELDS = ("movieId", "collectionId", "_id", "id")


def compose_movie_payload(
    movie_doc: dict[str, Any], changes: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Compose a full-replacement movie payload from a `list_movies` read (US2 update/move).

    mc-service PUT/POST is FULL-replacement, so an in-place update or a cross-collection move
    must resend the WHOLE movie. We read the persisted document, strip its server-assigned ids,
    and overlay only the requested conversational changes. `changes` (update only) supports the
    boolean flags `owned`/`ripped`/`childrens` and `addTags`/`removeTags` (a set-union / set-diff
    on the existing `tags` list). The source document is never mutated.
    """
    payload = {k: v for k, v in movie_doc.items() if k not in _MOVIE_ID_FIELDS}
    if not changes:
        return payload

    for flag in ("owned", "ripped", "childrens"):
        if flag in changes:
            payload[flag] = bool(changes[flag])

    add_tags = changes.get("addTags") or []
    remove_tags = changes.get("removeTags") or []
    if add_tags or remove_tags:
        tags = [str(t) for t in (payload.get("tags") or [])]
        for tag in add_tags:
            if str(tag) not in tags:
                tags.append(str(tag))
        removal = {str(t) for t in remove_tags}
        payload["tags"] = [t for t in tags if t not in removal]
    return payload


def _item(
    thread_id: str,
    proposal_id: str,
    item_id: str,
    operation: Operation,
    *,
    movie_candidate: EnrichedMovieCandidate | None = None,
    diff: dict[str, Any] | None = None,
) -> ProposalItem:
    return ProposalItem(
        item_id=item_id,
        operation=operation,
        movie_candidate=movie_candidate,
        diff=diff or {},
        idempotency_key=idempotency_key(thread_id, proposal_id, item_id),
    )


def build_add_proposal(
    *,
    thread_id: str,
    proposal_id: str,
    candidate: EnrichedMovieCandidate,
    target: CollectionRef,
    created_in_segment: str = "",
) -> Proposal:
    """Build the add-movie proposal, surfacing create-if-missing in the same preview.

    If `target.create_if_missing`, the create-collection item precedes the add item in the
    same proposal (one batch preview, FR-005a/FR-006); otherwise it is a single add item.
    """
    items: list[ProposalItem] = []
    if target.create_if_missing:
        items.append(
            _item(
                thread_id,
                proposal_id,
                "create-collection",
                Operation.create_collection,
                diff={"create_collection": target.name},
            )
        )
    items.append(
        _item(
            thread_id,
            proposal_id,
            "add-movie",
            Operation.add,
            movie_candidate=candidate,
            diff={"add_movie": candidate.title, "to": target.name or target.collection_id},
        )
    )
    kind = ProposalKind.batch if len(items) > 1 else ProposalKind.add_movie
    return Proposal(
        proposal_id=proposal_id,
        kind=kind,
        items=items,
        target_collection=target,
        created_in_segment=created_in_segment,
    )


def _organize_item(thread_id: str, proposal_id: str, item_id: str, op: OrganizeOp) -> ProposalItem:
    """Turn one planned organize op into a reviewable, idempotent proposal item."""
    movie_ref = (
        {"collectionId": op.collection_id, "movieId": op.movie_id}
        if op.movie_id is not None
        else {"collectionId": op.collection_id}
    )
    # A move also carries its destination so apply can add-to-dest then remove-from-source.
    if op.operation == Operation.move and op.dest_collection_id is not None:
        movie_ref["destCollectionId"] = op.dest_collection_id
    return ProposalItem(
        item_id=item_id,
        operation=op.operation,
        movie_candidate=op.movie_candidate,
        movie_ref=movie_ref,
        movie_payload=op.movie_payload,
        diff={str(op.operation): op.label or op.movie_id or ""},
        idempotency_key=idempotency_key(thread_id, proposal_id, item_id),
    )


def chunk_operations(
    operations: list[OrganizeOp], cap: int = BATCH_CAP
) -> list[list[OrganizeOp]]:
    """Split a plan into sequential batches of at most `cap` operations (FR-009b).

    An empty plan yields no batches. `cap` must be ≥1.
    """
    if cap < 1:
        raise ValueError("batch cap must be >= 1")
    return [operations[i : i + cap] for i in range(0, len(operations), cap)]


def build_organize_proposal(
    *,
    thread_id: str,
    proposal_id: str,
    operations: list[OrganizeOp],
    batch_index: int = 0,
    batch_total: int = 1,
    created_in_segment: str = "",
) -> Proposal:
    """Build ONE batch proposal from a (≤cap) list of planned organize operations (US2).

    Every item carries a deterministic idempotency key (at-most-once — FR-009/SC-006) so a
    retry of the same approved batch can't double-apply. `target_collection` is left None — an
    organize batch may span collections (each item carries its own `collectionId`).
    """
    items = [
        _organize_item(thread_id, proposal_id, f"{op.operation}-{i}", op)
        for i, op in enumerate(operations)
    ]
    if len(items) == 1:
        kind = _SINGLE_KIND.get(items[0].operation, ProposalKind.batch)
    else:
        kind = ProposalKind.batch
    return Proposal(
        proposal_id=proposal_id,
        kind=kind,
        items=items,
        target_collection=None,
        batch_index=batch_index,
        batch_total=batch_total,
        created_in_segment=created_in_segment,
    )


# Single-item organize proposals get a specific kind for the preview; multi-item → batch.
_SINGLE_KIND: dict[Operation, ProposalKind] = {
    Operation.update: ProposalKind.update_movie,
    Operation.remove: ProposalKind.delete_movie,
    Operation.move: ProposalKind.move_movie,
    Operation.add: ProposalKind.add_movie,
}
