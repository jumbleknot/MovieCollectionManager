"""Organizer node: collection/movie writes (HITL-gated) (T041, US1).

The organizer turns the curator's EnrichedMovieCandidate + a target collection into a
Proposal awaiting approval — it performs NO writes here (writes run on the approved-resume
path, Slice E/T044). Code-orchestrated (decided 2026-06-07): the LLM never selects MCP tools
or generates write args; the organizer resolves the target with a `list_collections` READ
and builds the proposal in code via `proposals.build_add_proposal`. Create-if-missing
surfaces the create-collection AND the add in one proposal (FR-005a/FR-006). Target matching
is case-insensitive to mirror mc-service's collation (per-owner name uniqueness).

`build_organizer(list_collections, gen_id)` is the seam: `list_collections` is an async read
(a closure over `invoke_tool` → movie-mcp in production; a stub in tests); `gen_id` mints the
proposal id (uuid4 in production; fixed in tests).

T050 (batch/update/remove + chunking + approval-time re-validation) extends this for US2.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from langchain_core.messages import AIMessage

from src.proposals import CollectionRef, EnrichedMovieCandidate, build_add_proposal

ListCollectionsFn = Callable[[], Awaitable[list[dict[str, Any]]]]
GenIdFn = Callable[[], str]


def build_organizer(*, list_collections: ListCollectionsFn, gen_id: GenIdFn | None = None) -> Any:
    """Build the organizer graph node from an injected `list_collections` read + id minter."""
    new_id: GenIdFn = gen_id or (lambda: str(uuid.uuid4()))

    async def organizer(state: dict[str, Any]) -> dict[str, Any]:
        candidate: EnrichedMovieCandidate | None = state.get("candidate")
        target_name = str(state.get("target_collection_name") or "").strip()

        if candidate is None:
            return {
                "messages": [
                    AIMessage(content="I don't have a movie to add yet — which film did you mean?")
                ],
                "pending_proposal": None,
            }

        collections = await list_collections()
        target, needs_clarify = _resolve_target(target_name, collections)
        if needs_clarify:
            # No named/generic target resolvable and no default collection — ask which, never
            # silently create one (T069/R14, RC3; user decision 2026-06-07). Keep the candidate;
            # the next turn names a collection and the curator threads it back here.
            names = ", ".join(str(c.get("name", "")) for c in collections if c.get("name"))
            listing = f" You have: {names}." if names else ""
            return {
                "pending_proposal": None,
                "add_stage": "awaiting_collection",
                "messages": [
                    AIMessage(
                        content=(
                            f"Which collection should I add {candidate.title} to?{listing}"
                        )
                    )
                ],
            }

        proposal = build_add_proposal(
            thread_id=str(state.get("thread_id") or ""),
            proposal_id=new_id(),
            candidate=candidate,
            target=target,
            created_in_segment=str(state.get("segment") or ""),
        )

        where = target.name or "the collection"
        verb = "create" if target.create_if_missing else "add to"
        return {
            "pending_proposal": proposal,
            "status": "awaiting_approval",
            "add_stage": "",
            "messages": [
                AIMessage(
                    content=(
                        f"Ready to {verb} \"{where}\" and add {candidate.title} "
                        f"({candidate.year}). Approve to apply."
                    )
                )
            ],
        }

    return organizer


# Generic references that mean "the user's default collection", not a literally-named one.
_GENERIC_TARGETS = frozenset(
    {"", "my collection", "my collections", "my list", "my movies", "default",
     "default collection", "the collection", "a collection", "my default collection"}
)


def _resolve_target(
    name: str, collections: list[dict[str, Any]]
) -> tuple[CollectionRef, bool]:
    """Resolve the add target to a CollectionRef, or signal that clarification is needed.

    Returns ``(target, needs_clarify)``:
    - a specifically-named target → an existing match (case-insensitive) else create-if-missing;
    - an empty/generic target ("my collection") → the user's `isDefault` collection;
    - an empty/generic target with NO default → ``needs_clarify=True`` (ask which, never create
      a literal "my collection" — T069/R14, RC3).
    """
    lowered = name.casefold().strip()
    if lowered and lowered not in _GENERIC_TARGETS:
        for collection in collections:
            if str(collection.get("name", "")).casefold() == lowered:
                return (
                    CollectionRef(
                        collection_id=str(collection["collectionId"]),
                        name=str(collection["name"]),
                    ),
                    False,
                )
        # A specific new name the user chose → create-if-missing (HITL-gated, FR-005a).
        return CollectionRef(name=name, create_if_missing=True), False

    # Empty/generic target → resolve to the user's default collection (FR-005b/FR-009).
    for collection in collections:
        if collection.get("isDefault"):
            return (
                CollectionRef(
                    collection_id=str(collection["collectionId"]),
                    name=str(collection["name"]),
                ),
                False,
            )
    return CollectionRef(name=name, create_if_missing=True), True
