"""HITL approval gate (T042, US1).

On a pending write the gate pauses the graph with LangGraph `interrupt()`, emitting an AG-UI
approval-request carrying the proposal preview (per-item visible — FR-006), and checkpoints
to agent-db. The paused run holds NO token (SC-004 — only non-sensitive state is
checkpointed). On approved resume the writes execute via the injected `execute` (a closure
over `invoke_tool`→movie-mcp in production) using each item's DETERMINISTIC idempotency key
(at-most-once — SC-006); a duplicate becomes `skipped_duplicate`, a missing target
`skipped_missing` (FR-009a) — the batch is never aborted. Reject applies nothing (FR-007).

Code-orchestrated (decided 2026-06-07): apply runs the items in proposal order (create →
add) and threads the newly-created collection id into the add — the LLM never drives writes.
The interrupt/resume runtime is exercised in T036; the apply/payload/preview logic here is pure.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from src.proposals import Operation, Proposal, Revalidation, to_movie_payload


@dataclass
class ExecOutcome:
    """Result of executing one write item (the injected `execute` classifies the upstream call)."""

    status: str  # "applied" | "skipped_duplicate" | "skipped_missing" | "failed"
    data: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class ApplyResult:
    """Aggregate outcome of applying a proposal's items at approval time."""

    applied_item_ids: list[str] = field(default_factory=list)
    skipped_item_ids: list[str] = field(default_factory=list)
    failed_item_ids: list[str] = field(default_factory=list)
    created_collection_id: str | None = None


ExecuteFn = Callable[[Operation, dict[str, Any], str], Awaitable[ExecOutcome]]

# Cleared when the add concludes so a finished add never leaks into the next turn (T069/R14,
# RC4). Mirrors graph._ADD_STATE_RESET (kept local to avoid importing the graph module here).
_ADD_STATE_RESET: dict[str, Any] = {
    "add_stage": "",
    "options": [],
    "resolved_pick": None,
    "candidate": None,
    "match_confidence": "",
    "pending_batches": [],
}

_REVALIDATION = {
    "skipped_duplicate": Revalidation.skipped_duplicate,
    "skipped_missing": Revalidation.skipped_missing,
    "applied": Revalidation.valid,
}


def build_approval_request(proposal: Proposal) -> dict[str, Any]:
    """Build the AG-UI approval-request preview (every item individually visible; no token)."""
    return {
        "type": "approval_request",
        "proposalId": proposal.proposal_id,
        "kind": str(proposal.kind),
        "target": proposal.target_collection.model_dump() if proposal.target_collection else None,
        "items": [
            {
                "itemId": item.item_id,
                "operation": str(item.operation),
                "diff": item.diff,
                "movie": (
                    item.movie_candidate.model_dump(by_alias=True)
                    if item.movie_candidate is not None
                    else None
                ),
            }
            for item in proposal.items
        ],
    }


async def apply_proposal(proposal: Proposal, *, execute: ExecuteFn) -> ApplyResult:
    """Execute an approved proposal's items in order; aggregate applied/skipped/failed."""
    result = ApplyResult()
    collection_id = (
        proposal.target_collection.collection_id if proposal.target_collection else None
    )

    for item in proposal.items:
        if item.operation == Operation.create_collection:
            name = proposal.target_collection.name if proposal.target_collection else None
            outcome = await execute(
                Operation.create_collection, {"name": name}, item.idempotency_key
            )
            if outcome.status == "applied" and outcome.data:
                collection_id = outcome.data.get("collectionId", collection_id)
                result.created_collection_id = collection_id
            _record(result, item, outcome)

        elif item.operation == Operation.add:
            candidate = item.movie_candidate
            add_target = (item.movie_ref or {}).get("collectionId") or collection_id
            # US1/US2 adds carry a TMDB candidate (→ to_movie_payload); an IMPORT create carries a
            # fully-composed raw payload instead (no candidate). Use whichever is present (014 T034).
            movie = to_movie_payload(candidate) if candidate is not None else item.movie_payload
            if movie is None or add_target is None:
                # No payload (e.g. create-collection was skipped) — can't add safely.
                _record(result, item, ExecOutcome(status="skipped_missing"))
                continue
            args = {"collectionId": add_target, "movie": movie}
            outcome = await execute(Operation.add, args, item.idempotency_key)
            _record(result, item, outcome)

        elif item.operation == Operation.update:
            ref = item.movie_ref or {}
            if not ref.get("collectionId") or not ref.get("movieId") or item.movie_payload is None:
                _record(result, item, ExecOutcome(status="skipped_missing"))
                continue
            args = {
                "collectionId": ref["collectionId"],
                "movieId": ref["movieId"],
                "movie": item.movie_payload,
            }
            outcome = await execute(Operation.update, args, item.idempotency_key)
            _record(result, item, outcome)

        elif item.operation == Operation.remove:
            ref = item.movie_ref or {}
            if not ref.get("collectionId") or not ref.get("movieId"):
                _record(result, item, ExecOutcome(status="skipped_missing"))
                continue
            args = {"collectionId": ref["collectionId"], "movieId": ref["movieId"]}
            outcome = await execute(Operation.remove, args, item.idempotency_key)
            _record(result, item, outcome)

        elif item.operation == Operation.move:
            # Cross-collection move = guarded add-to-dest THEN remove-from-source (US2/T070).
            # The remove runs ONLY if the add landed (applied or already-present duplicate), so a
            # failed add never deletes the source copy — no data loss. The two writes carry
            # distinct at-most-once keys derived from the item key.
            ref = item.movie_ref or {}
            src, movie_id, dest = (
                ref.get("collectionId"),
                ref.get("movieId"),
                ref.get("destCollectionId"),
            )
            if not src or not movie_id or not dest or item.movie_payload is None:
                _record(result, item, ExecOutcome(status="skipped_missing"))
                continue
            add_out = await execute(
                Operation.add,
                {"collectionId": dest, "movie": item.movie_payload},
                f"{item.idempotency_key}:add",
            )
            if add_out.status not in ("applied", "skipped_duplicate"):
                # Dest add failed → leave the source untouched and report the move as failed.
                _record(result, item, add_out)
                continue
            rm_out = await execute(
                Operation.remove,
                {"collectionId": src, "movieId": movie_id},
                f"{item.idempotency_key}:rm",
            )
            # The move completed if the source copy is gone — a 404 on remove means it already
            # drifted away, which still satisfies the move (count it applied, not skipped).
            move_out = (
                ExecOutcome(status="applied")
                if rm_out.status in ("applied", "skipped_missing")
                else rm_out
            )
            _record(result, item, move_out)

    return result


def _is_approved(decision: Any) -> bool:
    """Interpret the resume value as approve/reject (accepts a dict or a bare string)."""
    if isinstance(decision, dict):
        return decision.get("decision") == "approved"
    return bool(decision == "approved")


def build_approval_gate(*, execute: ExecuteFn) -> Any:
    """Build the HITL gate node: interrupt with the preview, then apply on approved resume.

    `execute` is the injected write executor (a closure over invoke_tool→movie-mcp bound to
    the run's subject token, wired at graph-compile time). The paused run carries no token.
    """
    from langchain_core.messages import AIMessage

    async def approval_gate(state: dict[str, Any]) -> dict[str, Any]:
        from langgraph.types import interrupt

        proposal: Proposal | None = state.get("pending_proposal")
        if proposal is None:
            return {}

        # Pauses here; resumes with the decision supplied on the approved/rejected resume.
        decision = interrupt(build_approval_request(proposal))

        if not _is_approved(decision):
            return {
                "pending_proposal": None,
                "status": "completed",
                "messages": [AIMessage(content="No problem — I didn't make any changes.")],
                **_ADD_STATE_RESET,
            }

        result = await apply_proposal(proposal, execute=execute)
        applied = len(result.applied_item_ids)
        skipped = len(result.skipped_item_ids)
        summary = f"Done — applied {applied} change(s)"
        summary += f", skipped {skipped} (already up to date)." if skipped else "."

        # Sequential batches (FR-009b): if more chunks remain, queue the next as pending and
        # loop back to the gate (the conditional edge re-enters this node → a fresh interrupt
        # for the next batch). Do NOT reset the add/organize lifecycle until the last batch.
        remaining: list[Proposal] = list(state.get("pending_batches") or [])
        if remaining:
            nxt, rest = remaining[0], remaining[1:]
            total = nxt.batch_total or (nxt.batch_index + 1)
            return {
                "pending_proposal": nxt,
                "pending_batches": rest,
                "status": "awaiting_approval",
                "apply_result": result,
                "messages": [
                    AIMessage(content=f"{summary} Next: batch {nxt.batch_index + 1} of {total}.")
                ],
            }
        return {
            "pending_proposal": None,
            "status": "completed",
            "apply_result": result,
            "messages": [AIMessage(content=summary)],
            **_ADD_STATE_RESET,
        }

    return approval_gate


def _record(result: ApplyResult, item: Any, outcome: ExecOutcome) -> None:
    item.revalidation = _REVALIDATION.get(outcome.status)
    if outcome.status == "applied":
        result.applied_item_ids.append(item.item_id)
    elif outcome.status in ("skipped_duplicate", "skipped_missing"):
        result.skipped_item_ids.append(item.item_id)
    else:
        result.failed_item_ids.append(item.item_id)
