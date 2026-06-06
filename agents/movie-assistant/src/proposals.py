"""Proposal assembly: idempotency keys, batch chunking, approval-time re-validation.

Implements: T041 (build + idempotency + create-if-missing), T050 (batch/chunk + re-validate).
Idempotency key = hash(thread_id, proposal_id, item_id) -> at-most-once apply
(FR-009/SC-006). Batch cap ~50, overflow chunked (FR-009b). Re-validation skips
now-duplicate/now-missing items, applies valid ones, never aborts the batch (FR-009a/SC-010).
"""

# TODO(T041/T050): Proposal/ProposalItem builders + chunking + re-validation helpers.
