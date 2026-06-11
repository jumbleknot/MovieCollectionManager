"""Proposal expiry at session end (T062, FR-008 / SC-007).

A pending proposal (a write awaiting HITL approval) is **transient, session-scoped** assistant
state — it MUST NOT auto-apply if abandoned, and it expires (writing nothing) when the user's
authenticated session ends. The first half is already guaranteed by the HITL design: the
`approval_gate` node pauses at `interrupt()` and applies writes only on an explicit approved
resume — no resume ⇒ no write. This module supplies the second half: a **session-end sweep**
that expires any pending proposal so a *late* resume (after the session ended) writes nothing.

Mechanism: clear `pending_proposal` (+ `pending_batches`) in the thread's checkpoint and mark
the thread `status="expired"`. On a later resume the `approval_gate` re-reads the state, sees
`pending_proposal is None`, and returns immediately — `execute` is never called (zero writes,
SC-007). The sweep is pure-control: it itself performs NO domain writes.

Trigger (deploy wiring): the BFF owns "session end" (logout / idle / absolute timeout) and the
`userId → threadId` mapping; on session end it calls the gateway to run `sweep_threads(graph,
<that user's threadIds>)`. The agent-side sweep + the zero-writes guarantee are implemented and
tested here; the BFF→gateway notification is the remaining deploy step (see tasks.md T062).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

# State fields reset on expiry — clears the pending write + the multi-turn add lifecycle so a
# swept thread holds no resumable proposal. Mirrors graph._ADD_STATE_RESET + the pending fields.
_EXPIRY_RESET: dict[str, Any] = {
    "pending_proposal": None,
    "pending_batches": [],
    "status": "expired",
    "add_stage": "",
    "options": [],
    "resolved_pick": None,
    "candidate": None,
    "match_confidence": "",
}


def has_pending_proposal(state: Mapping[str, Any]) -> bool:
    """Whether the thread state holds a proposal (single or queued batch) awaiting approval."""
    return state.get("pending_proposal") is not None or bool(state.get("pending_batches"))


def expire_pending_proposal(state: Mapping[str, Any]) -> dict[str, Any]:
    """Pure expiry transform: a state update that drops any pending proposal (zero writes).

    Returns an empty dict (a no-op, so the sweep is idempotent) when nothing is pending.
    """
    if not has_pending_proposal(state):
        return {}
    return dict(_EXPIRY_RESET)


def sweep_thread(graph: Any, thread_id: str) -> bool:
    """Expire a single thread's pending proposal in its checkpoint. Returns True if it expired one.

    Reads the thread's checkpointed state via the compiled graph and, if a proposal is pending,
    writes the expiry update back with `update_state`. No domain write occurs. Safe to call on a
    thread with no checkpoint or nothing pending (returns False).
    """
    config = {"configurable": {"thread_id": thread_id}}
    snapshot = graph.get_state(config)
    values: Mapping[str, Any] = getattr(snapshot, "values", None) or {}
    update = expire_pending_proposal(values)
    if not update:
        return False
    graph.update_state(config, update)
    return True


def sweep_threads(graph: Any, thread_ids: Iterable[str]) -> int:
    """Expire pending proposals across the given threads (a user's session). Returns the count."""
    return sum(1 for thread_id in thread_ids if sweep_thread(graph, thread_id))
