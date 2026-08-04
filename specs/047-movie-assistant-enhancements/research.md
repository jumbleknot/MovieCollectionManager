# Phase 0 Research: Movie Assistant Enhancements & Fixes

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Date**: 2026-08-02

Five questions. **RQ-4 is resolved** (product owner, 2026-08-02). **RQ-1 and RQ-2 still gate their
stories** and must be answered before the corresponding tasks are coded. RQ-3 and RQ-5 have working
defaults recorded here and can be confirmed during implementation.

---

## RQ-1 — What actually produces the generic reply for "navigate to &lt;collection name&gt;"? {#rq-1}

**Status**: OPEN — gating Story 1. This must be reproduced before the fix is written.

**Why it is open.** `"Sorry — I couldn't complete that just now. Please try again."` appears in
exactly four places, and **none of them is the navigator**:

| Site | Trigger |
|---|---|
| [graph.py:349](../../agents/movie-assistant/src/graph.py#L349) `_degrade_node` | `intent == "degraded"` — the classifier raised, or the error-rate circuit breaker is open |
| [curator.py:138](../../agents/movie-assistant/src/nodes/curator.py#L138) | entity extraction raised |
| [organizer.py:550](../../agents/movie-assistant/src/nodes/organizer.py#L550) | organize-plan extraction raised |
| [query.py:226](../../agents/movie-assistant/src/nodes/query.py#L226) | query extraction raised |

The navigator resolves targets in pure code with no model call, so it cannot emit this message. The
string does not exist anywhere in `frontend/` either, so it is not a client fallback.

**Candidate explanations, most to least likely:**

- **H1 — the circuit breaker is open.** `ErrorRateBreaker` trips at a 0.5 failure rate over a
  20-run window (min 5 samples) and stays open for 30 s
  ([circuit_breaker.py:59-68](../../agents/movie-assistant/src/circuit_breaker.py#L59-L68)). If
  large-library turns are failing often enough, *every* intent degrades for 30 s at a time and the
  member would read that as "navigate is broken". This is the explanation most consistent with
  "it used to work and stopped as the library grew".
- **H2 — misclassification.** The request is being routed to `query` (or another model-backed node)
  rather than `navigate`, and that node's extraction is failing.
- **H3 — classifier failure.** The supervisor's model call is raising for this input shape.

**How to discriminate** (all three are distinguishable from signals that already exist):

1. Reproduce against a seeded large library in the dev container and capture the gateway log —
   `create_app` configures the root logger, so node-level errors reach stdout.
2. Read the OTel counters: `record_turn_failure()` fires on H3 only; `record_turn(intent)` records
   the classified intent, which settles H2 outright.
3. Check `ErrorRateBreaker.state` / the `DEGRADE` flag to confirm or eliminate H1.

**What is already certain and worth fixing either way.** The navigator paginates the whole target
collection before it can navigate, and is not exempt from the 30-call/60 s limiter. That is a real
defect against FR-002 whatever RQ-1 concludes — see the plan's Story 1 section.

**Decision**: fix the pagination defect unconditionally; hold the FR-004/FR-005 error-message work
until the reproduction identifies which path is actually firing.

**Alternatives considered**: shipping the pagination fix and declaring the story done. Rejected —
the member's reported symptom is the generic message, and there is no evidence yet that the
pagination fix removes it.

---

## RQ-2 — By what mechanism does a progress line update *in place*? {#rq-2}

**Status**: OPEN — gating FR-014a/FR-014b in Story 3.

**Constraint.** The client currently subscribes to nothing but messages and render-tool calls:
`assistant-dock.tsx` mounts `useAgent` plus six `useRenderTool` registrations and there is **no**
`useCoAgent` / agent-state subscription anywhere in `frontend/mcm-app`. So no in-place channel
exists today.

**Options:**

| Option | Mechanism | Assessment |
|---|---|---|
| A | AG-UI `STATE_DELTA` / state snapshots + a client agent-state subscription | The protocol-correct answer. The gateway already emits AG-UI natively, so this needs no BFF translation and stays inside the constitution's AG-UI-native mandate. Cost: new client wiring. |
| B | Streamed assistant-message deltas | Cheapest, but AG-UI text deltas **append**; they cannot replace "1,200 of 2,300" with "1,300 of 2,300". Fails FR-014a as written. |
| C | Re-emit a `render_import_progress` tool call per update | Each emission is a new tool call, so the dock accumulates cards — this is exactly the message-flood FR-014a exists to prevent. |

**Leaning**: A. B is disqualified by append-only semantics; C reproduces the problem.

**To verify before committing**: that `@copilotkit/react-native`'s `useAgent` exposes the agent
state object and re-renders on `STATE_DELTA`. If it does not, the fallback is B **with FR-014a
renegotiated** — the spec would need to accept an appending progress line, which is a change the
product owner must approve rather than something to decide silently in implementation.

---

## RQ-3 — How is an interrupted import reported on the next turn? {#rq-3}

**Status**: Working answer recorded; confirm during implementation.

FR-016a/FR-016b require that applied rows survive an interruption and that the member is told where
it stopped. `ApplyResult` already tracks `applied_item_ids` / `skipped_item_ids` /
`failed_item_ids` / `failures`, but it is built inside `apply_proposal` and only surfaces once the
call returns — an interrupted run never returns.

**Decision**: persist a small running counter into graph state as the apply loop progresses
(`import_applied`, `import_total`, `import_proposal_id`), so the checkpoint holds enough to report
on. On the next turn, if a checkpointed import run is present and unfinished, report it and clear
it. Counters only — no payloads, keeping the checkpoint small.

**Rationale**: the checkpointer already persists graph state at each super-step; this reuses that
rather than introducing a job store, which the spec explicitly puts out of scope.

**Alternatives considered**: a dedicated import-run table in `agent-db` (rejected — out of scope,
and agent state is not domain data); re-deriving progress by diffing the collection against the
sheet on the next turn (rejected — expensive and racy).

---

## RQ-4 — Where does the media-format / rip-quality option list come from? {#rq-4}

**Status**: **RESOLVED 2026-08-02 (product owner) — Option A: expose the values through movie-mcp.**

**The tension.** FR-021/FR-024 require the assistant to offer exactly the values mc-service accepts.
Those values are `DVD`, `Blu-Ray`, `Blu-Ray 3D`, `UHD Blu-Ray` — the `MediaFormat` enum in
[movie.rs](../../backend/mc-service/src/domain/movie.rs), used for **both** `ownedMedia` and
`ripQuality`. But the constitution's *No Domain Logic in Agents* rule says agents "never own domain
rules, validation, or persistence".

**Options considered:**

| Option | Assessment |
|---|---|
| **A — expose the enum through movie-mcp as a read tool** | **Chosen.** Constitutionally clean: the agent asks the domain what it accepts and owns nothing. Cost: a new mc-service endpoint + MCP tool, which takes this feature outside the agent layer. |
| B — hardcode the four values in the agent's tool layer | Rejected. Duplicates domain data and rots silently the moment a format is added. |
| C — B plus a contract test pinning the agent's list to mc-service's enum | Rejected. Makes the rot loud rather than impossible, and still leaves domain values living in the agent. |

**Decision**: A. Full design in
[contracts/movie-metadata.md](./contracts/movie-metadata.md) — `GET /api/v1/movie-metadata` on
mc-service, wrapped by a `get_movie_metadata` read tool on movie-mcp, allowlisted to the organizer
only.

**Rationale**: the option list *is* domain data. B and C both keep it in the agent and differ only
in how quickly the drift is noticed; A removes the possibility. It also settles the constitution
gate outright rather than parking a justified violation in Complexity Tracking.

**Consequences — this is not a free choice, and the plan reflects all of them:**

- The feature is **no longer confined to the agent layer**. It now changes `backend/mc-service`
  (Rust) and `mcp-servers/movie-mcp` (Python), which adds Rust unit tests, mc-service HTTP authz
  integration tests, and a real-mc-service movie-mcp integration test.
- Story 4 gains a dependency chain: mc-service endpoint → movie-mcp tool → agent wiring. All three
  land in **one** PR and one commit — the layers are consistent at every point on `main`, the Nx
  test targets are per-project so a red unit tier names its own layer, and the specified graceful
  fallback (below) makes the deploy ordering safe on its own. Splitting the chain across PRs would
  spend an `app-e2e` slot on a change whose story-level acceptance cannot yet be demonstrated.
- The endpoint must derive the list from the enum by exhaustive match, so adding a `MediaFormat`
  variant fails to compile until the new value is published. A hand-maintained array would
  reintroduce exactly the rot that disqualified B.

**Notable finding while designing this.** The existing
`GET /api/v1/collections/{id}/movies/filter-options` endpoint looked like a candidate but cannot
serve this purpose — it aggregates values **observed** in a collection, so an empty collection
returns empty lists and a DVD-only collection would hide Blu-Ray. It answers "what can I filter by",
not "what may I choose".

**Fallback behaviour** (specified rather than left to implementation): if the metadata call fails,
the assistant skips the format question and completes the add with no formats recorded — it must
never fall back to a guessed list, which would put domain values back in the agent.

---

## RQ-5 — Audit-event granularity for a bulk import {#rq-5}

**Status**: Working answer recorded; this is the item deferred at `/speckit-clarify`.

**The tension.** *Immutable Audit Logging of Agent Actions* requires every agent action — tools
called, what was returned, every approval decision — in the append-only stream. A 2,000-row import
is 2,000 tool calls, so a literal reading means 2,000 audit events per import.

**Decision (default)**: keep per-write audit events. They are what makes an individual movie's
provenance auditable, and dropping them to a summary would weaken a NON-NEGOTIABLE control to save
storage — the wrong trade. The approval decision remains a single event, as today.

**To confirm during implementation**: that the audit sink absorbs a 2,000-event burst without
becoming the import's bottleneck. `emit_audit` already swallows its own exceptions and is designed
not to delay the tool result
([mcp_tools.py:354](../../agents/movie-assistant/src/tools/mcp_tools.py#L354)), so this is expected
to hold — but under the new bounded-concurrency apply it should be measured, not assumed.

**Alternatives considered**: one summary audit event per import (rejected — loses per-movie
provenance); sampling (rejected — an append-only audit trail with holes is not an audit trail).

---

## Confirmed findings that needed no research

These were verified by reading the code and are recorded so implementation does not re-litigate
them:

- **The import loop's root cause is proven, not hypothesised.** Trailing whitespace in the option
  label makes it strictly longer than the trimmed reply, so `resolve_option`'s `title in low`
  substring test can never match. See the plan's Story 2 section for the two file references.
- **Bulk-write rate exemption already exists.** Feature 040 added `skip_rate_limit=True` to the
  import node's reads and the approval gate's writes, with a comment recording that a 200-row import
  had been silently capped at 30. **FR-019a is already satisfied**; it reduces to a regression test.
  This corrects what I said when the clarification question was asked.
- **The import approval payload is already compact.** `build_approval_request` previews an import as
  a tab-level summary, not per-item, so the HITL interrupt is not a large-import bottleneck.
- **mc-service already enforces the ownership cross-field rules.** `OwnedMediaWhenOwnedSpec` and
  `RipQualityWhenRippedSpec` reject formats on an unowned movie and rip qualities on an unripped
  one, so FR-027 is validated in the domain layer — the agent must not duplicate it.
- **No golden re-record is needed.** Every changed resolver is deterministic pure code; no prompt,
  model binding, or classification path is touched. This should still be asserted by running the
  golden suite, not assumed.
