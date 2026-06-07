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

        target = await _resolve_target(target_name, list_collections)
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


async def _resolve_target(name: str, list_collections: ListCollectionsFn) -> CollectionRef:
    """Find an existing reachable collection by (case-insensitive) name, else create-if-missing."""
    if not name:
        # No named target — leave it to be created/clarified; create-if-missing with empty name
        # is invalid, so signal create with the (empty) name and let approval surface it.
        return CollectionRef(name=name, create_if_missing=True)
    collections = await list_collections()
    lowered = name.casefold()
    for collection in collections:
        if str(collection.get("name", "")).casefold() == lowered:
            return CollectionRef(
                collection_id=str(collection["collectionId"]), name=str(collection["name"])
            )
    return CollectionRef(name=name, create_if_missing=True)
