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

T050 (US2): when `intent == "organize"` and `list_movies` + `plan` are injected, the organizer
takes the model's typed PLAN (code-orchestrated — the LLM never selects tools or forges
payloads), resolves each operation to a movie in the named collection, builds a CHUNKED batch
of proposals (≤50 each, FR-009b), and previews the first batch; remaining batches advance
sequentially through the approval gate. MVP organize scope = multi-item REMOVE (update/move
follow up; the proposals/apply/movie-mcp layers already support update).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Awaitable, Callable, Sequence
from typing import TYPE_CHECKING, Any

from langchain_core.messages import AIMessage

from src.proposals import (
    CollectionRef,
    EnrichedMovieCandidate,
    Operation,
    OrganizeOp,
    build_add_proposal,
    build_organize_proposal,
    chunk_operations,
)

if TYPE_CHECKING:
    from src.eval.cassette import ChatModel

ListCollectionsFn = Callable[[], Awaitable[list[dict[str, Any]]]]
ListMoviesFn = Callable[[str], Awaitable[list[dict[str, Any]]]]
PlanFn = Callable[[Sequence[Any]], dict[str, Any]]
GenIdFn = Callable[[], str]


def plan_operations(model: ChatModel, messages: Sequence[Any]) -> dict[str, Any]:
    """Extract the organize plan from the request: which collection + which items to change.

    Returns `{"collection": str|null, "operations": [{"op": "remove", "title": str}]}`.
    Defensive `{}`-ish default on any parse failure so the organizer reports "nothing to do"
    rather than acting on a hallucinated plan (the approval gate is still the safety net).
    Pure w.r.t. the model (injected — T050/T032). MVP supports the `remove` op.
    """
    last = messages[-1].content if messages else ""
    prompt = (
        "Extract a movie-collection organize plan from the user's request.\n"
        'Reply with ONLY JSON: {"collection": string|null, "operations": '
        '[{"op": "remove", "title": string}]}. No prose.\n'
        '"collection" is the collection to change; "operations" lists each movie to remove by '
        "its title. Use [] if there is nothing to remove.\n"
        f"Request: {last}"
    )
    try:
        parsed = dict(json.loads(str(model.invoke(prompt).content)))
    except (ValueError, TypeError):
        return {"collection": None, "operations": []}
    parsed.setdefault("operations", [])
    return parsed


def build_organizer(
    *,
    list_collections: ListCollectionsFn,
    list_movies: ListMoviesFn | None = None,
    plan: PlanFn | None = None,
    gen_id: GenIdFn | None = None,
) -> Any:
    """Build the organizer graph node from injected reads + id minter (+ US2 plan/list_movies)."""
    new_id: GenIdFn = gen_id or (lambda: str(uuid.uuid4()))

    async def organizer(state: dict[str, Any]) -> dict[str, Any]:
        if state.get("intent") == "organize" and plan is not None and list_movies is not None:
            return await _organize(state, list_collections, list_movies, plan, new_id)
        return await _add(state, list_collections, new_id)

    return organizer


async def _add(
    state: dict[str, Any], list_collections: ListCollectionsFn, new_id: GenIdFn
) -> dict[str, Any]:
    """US1 add path: turn the curator's candidate + target into an add proposal (HITL-gated)."""
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
                AIMessage(content=f"Which collection should I add {candidate.title} to?{listing}")
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


async def _organize(
    state: dict[str, Any],
    list_collections: ListCollectionsFn,
    list_movies: ListMoviesFn,
    plan: PlanFn,
    new_id: GenIdFn,
) -> dict[str, Any]:
    """US2 organize path: model plan → resolve items in the named collection → chunked batch
    preview. Code-orchestrated: the model only names the collection + titles; CODE resolves
    movie ids and builds the idempotent proposals. MVP supports the `remove` op."""
    parsed = plan(state.get("messages", []))
    collection_name = str(parsed.get("collection") or state.get("target_collection_name") or "")
    operations = parsed.get("operations") or []

    collections = await list_collections()
    target, _ = _resolve_target(collection_name.strip(), collections)
    if target.collection_id is None:
        # Organize needs an existing collection to act on — ask which.
        names = ", ".join(str(c.get("name", "")) for c in collections if c.get("name"))
        listing = f" You have: {names}." if names else ""
        return {
            "pending_proposal": None,
            "messages": [AIMessage(content=f"Which collection should I organize?{listing}")],
        }

    movies = await list_movies(target.collection_id)
    by_title = {str(m.get("title", "")).casefold(): m for m in movies}

    ops: list[OrganizeOp] = []
    unresolved: list[str] = []
    for operation in operations:
        if str(operation.get("op")) != "remove":  # MVP: remove only
            continue
        title = str(operation.get("title") or "").strip()
        movie = by_title.get(title.casefold())
        if movie is None:
            if title:
                unresolved.append(title)
            continue
        ops.append(
            OrganizeOp(
                operation=Operation.remove,
                collection_id=target.collection_id,
                movie_id=str(movie["movieId"]),
                label=title or str(movie.get("title", "")),
            )
        )

    if not ops:
        miss = f" I couldn't find: {', '.join(unresolved)}." if unresolved else ""
        return {
            "pending_proposal": None,
            "messages": [
                AIMessage(content=f'I didn\'t find anything to change in "{target.name}".{miss}')
            ],
        }

    batches = chunk_operations(ops)
    proposals = [
        build_organize_proposal(
            thread_id=str(state.get("thread_id") or ""),
            proposal_id=new_id(),
            operations=batch,
            batch_index=i,
            batch_total=len(batches),
            created_in_segment=str(state.get("segment") or ""),
        )
        for i, batch in enumerate(batches)
    ]

    batch_note = f" (batch 1 of {len(batches)})" if len(batches) > 1 else ""
    miss = f" I couldn't find: {', '.join(unresolved)}." if unresolved else ""
    return {
        "pending_proposal": proposals[0],
        "pending_batches": proposals[1:],
        "status": "awaiting_approval",
        "messages": [
            AIMessage(
                content=(
                    f'Ready to remove {len(ops)} movie(s) from "{target.name}"{batch_note}. '
                    f"Approve to apply.{miss}"
                )
            )
        ],
    }


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
