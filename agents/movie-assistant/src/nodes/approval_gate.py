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

import asyncio
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

from src.proposals import Operation, Proposal, Revalidation, to_movie_payload
from src.tools.generative_ui_tools import RENDER_IMPORT_REPORT, render_import_report
from src.tools.ui_action_tools import NAVIGATE_TO_MOVIE, navigate_to_movie


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
    # Per-failure detail (title + reason) so the user can see WHICH movies failed and WHY — an
    # import can fail a subset and the count alone isn't actionable (feature 014 follow-up).
    failures: list[dict[str, str]] = field(default_factory=list)
    # Items dropped because their source tab was excluded at the import preview (FR-020a) — not a
    # failure, just not written. Always empty for non-import (organize/add) proposals.
    excluded_item_ids: list[str] = field(default_factory=list)
    created_collection_id: str | None = None
    # 040 US4: the collection + movie id of a successfully-added single movie, so the gate can
    # navigate the user to its detail screen after the add. Only set for an add that applied.
    added_movie_id: str | None = None
    added_collection_id: str | None = None


ExecuteFn = Callable[[Operation, dict[str, Any], str], Awaitable[ExecOutcome]]

# Cleared when the add concludes so a finished add never leaks into the next turn (T069/R14,
# RC4). Mirrors graph._ADD_STATE_RESET (kept local to avoid importing the graph module here).
_ADD_STATE_RESET: dict[str, Any] = {
    "add_stage": "",
    "add_target": None,
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
    """Build the AG-UI preview payload for a pending proposal (no token).

    An IMPORT proposal (carries `import_summary`) previews as a single `import_preview` summary
    card — tab-level counts + whole-tab exclude toggles (FR-020/FR-020a) — because it can hold
    hundreds of rows. Every other proposal (add/organize) previews per-item (FR-006).
    """
    if proposal.import_summary is not None:
        return {
            "type": "import_preview",
            "proposalId": proposal.proposal_id,
            "summary": proposal.import_summary,
        }
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


def _apply_concurrency() -> int:
    """How many add/update writes may be in flight at once (047 US3, FR-013).

    Named and env-overridable rather than a literal at the call site: this is the knob an
    operator reaches for when mc-service is under load, and a bare `8` buried in a gather is not
    findable. Clamped to >= 1 so a misconfigured 0 cannot deadlock the import.
    """
    import os

    try:
        return max(1, int(os.environ.get("IMPORT_APPLY_CONCURRENCY", IMPORT_APPLY_CONCURRENCY)))
    except ValueError:
        return IMPORT_APPLY_CONCURRENCY


IMPORT_APPLY_CONCURRENCY = 8

# How often the apply loop reports progress (FR-014a / SC-008). Emitting per item would be a
# 2,000-message flood in another costume — the very thing the single in-place line exists to
# prevent — while emitting only at the end is indistinguishable from a hang. Every 25 items plus
# a guaranteed final report keeps a 2,000-row run under ~80 updates and well inside SC-008's
# 10-second freshness even when each write is slow.
IMPORT_PROGRESS_EVERY = 25

# (processed, total, state) — `state` is "running" or "waiting" (FR-019b). Kept as a third
# positional with a default so existing callers are unaffected.
ProgressFn = Callable[..., Awaitable[None]]

# What `invoke_tool` returns when the per-agent limiter throttles a call. Matched rather than
# introducing a new status code, because the limiter's message IS the contract the tool layer
# already surfaces, and a parallel enum would drift from it.
_THROTTLED_MARKER = "assistant is busy"

# Cleared when an import run concludes (FR-014b). An unfinished run leaves these SET, which is
# exactly the signal FR-016a's next-turn report looks for.
_IMPORT_PROGRESS_RESET: dict[str, Any] = {
    "import_total": 0,
    "import_applied": 0,
    "import_run_id": "",
    "import_state": "",
}


async def apply_proposal(
    proposal: Proposal,
    *,
    execute: ExecuteFn,
    excluded_tabs: Iterable[str] = (),
    on_progress: ProgressFn | None = None,
) -> ApplyResult:
    """Execute an approved proposal's items in order; aggregate applied/skipped/failed.

    `excluded_tabs` (import only — FR-020a): items whose source tab the user unchecked at the
    preview are dropped without writing and reported separately. Empty for add/organize.

    `on_progress(processed, total)` (import only — FR-014a) is awaited as the apply advances,
    throttled to `IMPORT_PROGRESS_EVERY` and always called once with the final count. It counts
    items PROCESSED, not items applied: a run containing duplicates would otherwise stop short of
    its total and read as stalled forever.
    """
    result = ApplyResult()
    excluded = {str(t) for t in excluded_tabs}
    collection_id = (
        proposal.target_collection.collection_id if proposal.target_collection else None
    )

    # 047 US3: add/update items are applied with BOUNDED CONCURRENCY, everything else stays
    # strictly sequential. create_collection must finish first because its new id threads into
    # every add; move is an add-then-remove pair whose ordering is the safety property; remove is
    # destructive. Only the two idempotent, independent operations are parallelised.
    #
    # Outcomes are recorded in ITEM order after the gather, never in completion order — a report
    # whose row order depends on which write happened to finish first is not reproducible, and
    # `added_movie_id` would become last-to-finish rather than last-in-proposal.
    deferred: list[tuple[int, Any, Operation, dict[str, Any]]] = []
    add_targets: dict[int, str] = {}
    outcomes: dict[int, ExecOutcome] = {}
    ordered: list[Any] = []

    for position, item in enumerate(proposal.items):
        if excluded and str((item.diff or {}).get("tab") or "") in excluded:
            result.excluded_item_ids.append(item.item_id)
            continue
        ordered.append((position, item))
        if item.operation == Operation.create_collection:
            name = proposal.target_collection.name if proposal.target_collection else None
            outcome = await execute(
                Operation.create_collection, {"name": name}, item.idempotency_key
            )
            if outcome.status == "applied" and outcome.data:
                collection_id = outcome.data.get("collectionId", collection_id)
                result.created_collection_id = collection_id
            outcomes[position] = outcome

        elif item.operation == Operation.add:
            candidate = item.movie_candidate
            add_target = (item.movie_ref or {}).get("collectionId") or collection_id
            # US1/US2 adds carry a TMDB candidate (→ to_movie_payload); an IMPORT create carries
            # a fully-composed raw payload instead (no candidate). Use whichever is set (014 T034).
            movie = (
                to_movie_payload(
                    candidate,
                    owned=bool(item.owned),
                    # 047 US4: the ownership follow-up answers were collected BEFORE the
                    # proposal was built and ride on the item, so an approval arriving turns
                    # later still applies exactly what the member chose.
                    owned_media=item.owned_media,
                    ripped=bool(item.ripped),
                    rip_quality=item.rip_quality,
                )
                if candidate is not None
                else item.movie_payload
            )
            if movie is None or add_target is None:
                # No payload (e.g. create-collection was skipped) — can't add safely.
                outcomes[position] = ExecOutcome(status="skipped_missing")
                continue
            # Carry the RESOLVED target through rather than recomputing it later: it is either
            # the item's own ref, the proposal's existing collection, or the one create_collection
            # just made, and only this branch knows which.
            add_targets[position] = str(add_target)
            deferred.append((position, item, Operation.add,
                             {"collectionId": add_target, "movie": movie}))

        elif item.operation == Operation.update:
            ref = item.movie_ref or {}
            if not ref.get("collectionId") or not ref.get("movieId") or item.movie_payload is None:
                outcomes[position] = ExecOutcome(status="skipped_missing")
                continue
            args = {
                "collectionId": ref["collectionId"],
                "movieId": ref["movieId"],
                "movie": item.movie_payload,
            }
            deferred.append((position, item, Operation.update, args))

        elif item.operation == Operation.remove:
            ref = item.movie_ref or {}
            if not ref.get("collectionId") or not ref.get("movieId"):
                outcomes[position] = ExecOutcome(status="skipped_missing")
                continue
            args = {"collectionId": ref["collectionId"], "movieId": ref["movieId"]}
            outcome = await execute(Operation.remove, args, item.idempotency_key)
            outcomes[position] = outcome

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
                outcomes[position] = ExecOutcome(status="skipped_missing")
                continue
            add_out = await execute(
                Operation.add,
                {"collectionId": dest, "movie": item.movie_payload},
                f"{item.idempotency_key}:add",
            )
            if add_out.status not in ("applied", "skipped_duplicate"):
                # Dest add failed → leave the source untouched and report the move as failed.
                outcomes[position] = add_out
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
            outcomes[position] = move_out


    # ── the bounded-concurrency pass (047 US3, FR-013) ────────────────────────────────────────
    if deferred:
        limit = asyncio.Semaphore(_apply_concurrency())
        total = len(deferred)
        processed = 0
        throttled: set[int] = set()

        async def _run(position: int, item: Any, op: Operation, args: dict[str, Any]) -> None:
            nonlocal processed
            async with limit:
                outcomes[position] = await execute(op, args, item.idempotency_key)
            processed += 1
            # FR-019b: a throttled write must not read as a stalled number. The member cannot
            # tell a slow import from a dead one, and "1,300 of 2,300" frozen for a minute is
            # indistinguishable from a crash.
            outcome = outcomes.get(position)
            if outcome is not None and _THROTTLED_MARKER in str(outcome.error or "").lower():
                throttled.add(position)
            # Report on the throttle boundary, and always on the last item so the line lands on
            # its total rather than at the last multiple of the interval.
            if on_progress is not None and (
                processed % IMPORT_PROGRESS_EVERY == 0 or processed == total
            ):
                # "waiting" describes the CURRENT window, not the whole run — a run that was
                # throttled early and recovered must go back to "running", or the line would
                # claim to be waiting right up to the final report.
                state = "waiting" if throttled else "running"
                throttled.clear()
                await on_progress(processed, total, state)

        await asyncio.gather(*(_run(*entry) for entry in deferred))

    # ── record every outcome in ITEM order, never completion order ────────────────────────────
    for position, item in ordered:
        recorded = outcomes.get(position)
        if recorded is None:
            continue  # excluded or short-circuited without a write
        if item.operation == Operation.add and recorded.status == "applied" and recorded.data:
            # 040 US4: capture the created movie id so the gate can open its detail screen.
            movie_id = recorded.data.get("movieId")
            if movie_id:
                result.added_movie_id = str(movie_id)
                target = add_targets.get(position)
                if target:
                    result.added_collection_id = target
        _record(result, item, recorded)

    return result


def _is_approved(decision: Any) -> bool:
    """Interpret the resume value as approve/reject (accepts a dict or a bare string)."""
    if isinstance(decision, dict):
        return decision.get("decision") == "approved"
    return bool(decision == "approved")


def build_approval_gate(*, execute: ExecuteFn, on_progress: ProgressFn | None = None) -> Any:
    """Build the HITL gate node: interrupt with the preview, then apply on approved resume.

    `execute` is the injected write executor (a closure over invoke_tool→movie-mcp bound to
    the run's subject token, wired at graph-compile time). The paused run carries no token.

    `on_progress` (047 US3 / FR-014a) is the transport-side emitter for the in-place progress
    line. Injected rather than called directly so this node stays pure — the gate knows how far
    the apply has got, not how a client is told.
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

        # Whole-tab exclusions chosen at the import preview ride the approved-decision dict.
        excluded_tabs = decision.get("excludedTabs", []) if isinstance(decision, dict) else []
        is_import = proposal.import_summary is not None
        # Progress is an IMPORT surface (FR-014a). A three-item add would emit a progress line
        # that is replaced before it can be read, which is noise, not feedback.
        progress = on_progress if is_import else None
        result = await apply_proposal(
            proposal, execute=execute, excluded_tabs=excluded_tabs, on_progress=progress
        )
        report = _build_import_report(proposal, result) if is_import else None
        summary = (
            _import_summary_message(result, report)
            if report is not None
            else _organize_summary_message(result)
        )

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

        # Final batch: emit the collapsible import-report card alongside the concise summary when
        # an import had any skipped or failed rows, so the user can expand the per-row detail
        # (enhancement 3). A clean import (nothing skipped/failed) shows just the summary.
        tool_calls: list[dict[str, Any]] = []
        if report is not None and (report["skipped"] or report["failed"]):
            tool_calls = [
                {
                    "name": RENDER_IMPORT_REPORT,
                    "args": render_import_report(
                        imported=report["imported"],
                        skipped=report["skipped"],
                        failed=report["failed"],
                    ),
                    "id": f"import-report-{proposal.proposal_id}",
                }
            ]
        # 040 US4: after a successful single-movie add (not an import), open the new movie's detail
        # screen so the user can review it. The client's NAVIGATE_TO_MOVIE handler authorizes via
        # the BFF (default-deny) before routing — same allowlisted UI-action the navigator uses.
        summary_out = summary
        if not is_import and result.added_movie_id and result.added_collection_id:
            tool_calls = [
                *tool_calls,
                {
                    "name": NAVIGATE_TO_MOVIE,
                    "args": navigate_to_movie(result.added_collection_id, result.added_movie_id),
                    "id": f"nav-added-{result.added_collection_id}-{result.added_movie_id}",
                },
            ]
            summary_out = f"{summary} Opening it now."
        return {
            "pending_proposal": None,
            "status": "completed",
            "apply_result": result,
            "messages": [AIMessage(content=summary_out, tool_calls=tool_calls)],
            # FR-014b: the run is over, so the progress surface is REPLACED by the report rather
            # than left showing its last number. FR-016a's "was a run interrupted?" check reads
            # these same fields, so clearing them here is what makes a COMPLETED run
            # distinguishable from one that stopped partway.
            **_IMPORT_PROGRESS_RESET,
            **_ADD_STATE_RESET,
        }

    return approval_gate


def _organize_summary_message(result: ApplyResult) -> str:
    """Human summary after applying an add/organize proposal."""
    applied = len(result.applied_item_ids)
    skipped = len(result.skipped_item_ids)
    summary = f"Done — applied {applied} change(s)"
    summary += f", skipped {skipped} (already up to date)." if skipped else "."
    return summary


def _build_import_report(proposal: Proposal, result: ApplyResult) -> dict[str, Any]:
    """Assemble the post-import report: rows skipped BEFORE write (plan-time, from the proposal's
    summary) + rows mc-service REJECTED at write time (apply failures). Each is a [{title, reason}].
    """
    plan_skips = list((proposal.import_summary or {}).get("skipped") or [])
    return {
        "imported": len(result.applied_item_ids),
        "skipped": [
            {"title": str(s.get("title") or "?"), "reason": str(s.get("reason") or "skipped")}
            for s in plan_skips
        ],
        "failed": list(result.failures),
    }


def _import_summary_message(result: ApplyResult, report: dict[str, Any] | None = None) -> str:
    """Concise human summary after an import (counts only). The per-row detail of what was skipped
    or failed lives in the collapsible import-report card (enhancement 3)."""
    imported = len(result.applied_item_ids)
    parts = [f"Done — imported {imported} movie(s)."]
    if result.excluded_item_ids:
        parts.append(f"Skipped {len(result.excluded_item_ids)} from excluded tab(s).")
    if result.skipped_item_ids:
        parts.append(f"{len(result.skipped_item_ids)} already up to date.")
    n_skip = len(report["skipped"]) if report else 0
    n_fail = len(report["failed"]) if report else len(result.failed_item_ids)
    if n_skip:
        parts.append(f"{n_skip} skipped (not imported).")
    if n_fail:
        parts.append(f"{n_fail} could not be imported.")
    if n_skip or n_fail:
        parts.append("See the import report below for the details.")
    return " ".join(parts)


# Diff keys that carry a human-readable movie title, in priority order.
_TITLE_DIFF_KEYS = ("add_movie", "update_movie", "remove_movie", "move_movie", "title")


def _item_title(item: Any) -> str:
    """Best-effort human title for a proposal item (for the failure report)."""
    diff = getattr(item, "diff", None) or {}
    for key in _TITLE_DIFF_KEYS:
        value = diff.get(key)
        if isinstance(value, str) and value.strip():
            return value
    payload = getattr(item, "movie_payload", None)
    if isinstance(payload, dict) and payload.get("title"):
        return str(payload["title"])
    return str(getattr(item, "item_id", "?"))


def _record(result: ApplyResult, item: Any, outcome: ExecOutcome) -> None:
    item.revalidation = _REVALIDATION.get(outcome.status)
    if outcome.status == "applied":
        result.applied_item_ids.append(item.item_id)
    elif outcome.status in ("skipped_duplicate", "skipped_missing"):
        result.skipped_item_ids.append(item.item_id)
    else:
        result.failed_item_ids.append(item.item_id)
        reason = outcome.error or outcome.status or "unknown error"
        result.failures.append({"title": _item_title(item), "reason": str(reason)})
