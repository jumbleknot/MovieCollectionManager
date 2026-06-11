# Phase 1 Data Model: Multi-Agent Conversational Assistant (Phase 1 MVP)

**Feature**: `012-multi-agent-mvp` | **Date**: 2026-06-06

All structures below are **agent state** (orchestration), persisted in the isolated `agent-db` via the LangGraph checkpointer, or transient run values. **No `mc-service`/`mc-db` domain schema changes** — domain entities (Collection, Movie) are referenced read/write through `movie-mcp`, never redefined here (FR-022, additive-only).

Raw tokens (subject or exchanged) **MUST NOT** appear in any persisted/checkpointed field, trace, or log (SC-004).

---

## Persistence & isolation

| Store | Holds | Lifecycle |
|---|---|---|
| `agent-db` (PostgreSQL, isolated) | LangGraph checkpoints = `GraphState` per `threadId` (turns, plan, pending proposals, sanitized UI snapshot) | Purged at user session end (FR-008); no domain data |
| Redis (existing `mcm-redis`) | `userId → threadId` mapping; per-user agent rate-limit + cost-ceiling counters | Session-scoped |
| OpenSearch (append-only) | Audit events (tool calls, UI actions, approval decisions) | ≥90-day audit retention |
| TMDB (external, read-only) | Source of `EnrichedMovieCandidate` data | Not persisted unless its proposal is approved |

---

## Entities

### GraphState (checkpointed; one per `threadId`)

The typed LangGraph state (`src/state.py`). Bounded-context isolated; single user.

| Field | Type | Notes |
|---|---|---|
| `thread_id` | string (UUID) | One user conversation; maps from `userId` in Redis. |
| `messages` | list[Message] | Conversation turns; compacted/summarized to bound context (PRD R2.4). |
| `thread_summary` | string \| null | Running summary for long threads. |
| `current_plan` | Plan \| null | Working plan for the active request (specialist-internal). |
| `route` | enum(`supervisor`,`curator`,`organizer`,`approval_gate`) | Current node; supervisor routes only. |
| `ui_snapshot` | UiStateSnapshot \| null | Sanitized structural UI state for "this" resolution. |
| `pending_proposal` | Proposal \| null | Set when a write awaits approval; cleared on resolve. |
| `last_tool_results` | list[ToolResult] | Recent tool outputs feeding the planner. |
| `status` | enum(`active`,`awaiting_approval`,`completed`,`expired`,`error`) | Drives resume/expiry. |

**Excluded by invariant**: no `subject_token`, no exchanged token, no raw JWT, no PII-bearing user-entered field. Identity is carried only as non-sensitive `userId`/`threadId`; the subject token arrives as an **ephemeral run value** per invocation/resume and is never written here.

### Proposal

A concrete change (or batch) awaiting approval. Lives inside `GraphState.pending_proposal` while pending; the resolved decision is audited to OpenSearch.

| Field | Type | Notes |
|---|---|---|
| `proposal_id` | string (UUID) | Stable identity; basis of idempotency keys. |
| `kind` | enum(`add_movie`,`update_movie`,`delete_movie`,`create_collection`,`batch`) | A `batch` wraps ≥1 item. |
| `items` | list[ProposalItem] | Each individually visible in the preview (single-batch approval). |
| `target_collection` | CollectionRef \| null | Existing collection, or a to-be-created one (`create_if_missing`). |
| `status` | enum(`pending`,`approved`,`rejected`,`partially_applied`,`expired`) | — |
| `batch_index` / `batch_total` | int | Set when an oversized request was chunked (FR-009b). |
| `created_in_segment` | string | Run-segment marker; the proposal itself carries no token. |

**Rules**:
- A batch is capped at **≤50 items**; larger requests are split into sequential `Proposal`s (R9, FR-009b).
- Every write item produces an **idempotency key** = hash(`thread_id`,`proposal_id`,`item.item_id`) → at-most-once apply (FR-009, SC-006).
- On approval each item is **re-validated** against current domain state; drifted items → `skipped` + reported; valid items applied; batch not aborted (FR-009a, SC-010).
- Expires when the user session ends if never approved (FR-008, SC-007).

### ProposalItem

| Field | Type | Notes |
|---|---|---|
| `item_id` | string | Unique within the proposal. |
| `operation` | enum(`add`,`update`,`remove`,`create_collection`) | — |
| `movie_candidate` | EnrichedMovieCandidate \| null | For add/update; preview content. |
| `movie_ref` | MovieRef \| null | For update/remove of an existing movie. |
| `diff` | object | Human-readable "what will change" for the preview. |
| `revalidation` | enum(`valid`,`skipped_duplicate`,`skipped_missing`) \| null | Set at approval time. |
| `idempotency_key` | string | Derived; never reused across distinct items. |

### ApprovalDecision (audit record → OpenSearch)

| Field | Type | Notes |
|---|---|---|
| `decision_id` | string (UUID) | — |
| `proposal_id` | string | FK to the Proposal. |
| `user_id` | string (Keycloak UUID) | Actor; never email/username. |
| `decision` | enum(`approved`,`rejected`) | — |
| `decided_at` | timestamp (UTC ISO 8601) | — |
| `applied_item_ids` / `skipped_item_ids` | list[string] | Outcome after re-validation. |
| `request_id` | string | Correlation ID for end-to-end trace. |

Forms the audit trail for SC-002 (0 writes without a recorded approval). Append-only; write-only service account.

### EnrichedMovieCandidate (transient; read-only)

Movie metadata fetched from TMDB via `web-api-mcp` to populate a proposal preview. **Not persisted** unless its proposal is approved (then it becomes a domain write via `movie-mcp`).

| Field | Type | Notes |
|---|---|---|
| `source` | enum(`tmdb`) | Provenance. |
| `source_id` | string | TMDB id (maps to a domain `ExternalId`). |
| `title` / `year` / `overview` / `genres` / `poster_url` / `language` | per existing movie schema | Shaped to what the `mc-service` add-movie contract accepts. |
| `match_confidence` | enum(`exact`,`ambiguous`,`none`) | Drives the "no match / ambiguous" edge case (offer options, never fabricate). |

### UiStateSnapshot (sanitized; structural only)

Sanitized at the BFF (sole sanitization point) before reaching the prompt. Allowlist only.

| Field | Type | Notes |
|---|---|---|
| `current_screen` | string | e.g. `collection`, `movie-detail`, `home`. |
| `collection_id` | string \| null | Resolves "add this to **this** collection" (US3). |
| `movie_id` | string \| null | Loaded record id. |
| `active_filter_keys` | list[string] | Structural filter keys only — **no** values. |
| `nav_depth` | int | — |

**Excluded**: user-entered values, PII-bearing fields, anything not on the allowlist (stripped before leaving the client and again at the BFF).

### ThreadMapping (Redis)

| Field | Type | Notes |
|---|---|---|
| `user_id` | string | Keycloak UUID. |
| `thread_id` | string | Active conversation. |
| `expires_at` | timestamp | Tied to session lifetime (FR-008). |

### RateBudgetCounter (Redis)

| Field | Type | Notes |
|---|---|---|
| `user_id` | string | Per-user scope (not per-IP). |
| `window_request_count` | int | Per-user request rate limit (FR-020a). |
| `session_cost_accumulated` | number | From LangFuse per-turn cost; checked against ceiling. |

---

## Referenced domain entities (NOT modified — via `movie-mcp` → `mc-service`)

- **Collection** — owner + ACL (`mc-owner`/`mc-contributor`/`mc-viewer`); name-unique per owner. Assistant may target an existing one or propose creating one (`create_if_missing`); never renames/deletes (out of scope). "Wishlist" = a user-named Collection.
- **Movie** — belongs to a Collection; unique per collection; cursor-paginated. Add/update/remove only, all HITL-gated.

These remain the **single source of truth** (FR-022). The agent reads current state at plan time and re-reads at approval time; it never caches domain data as authoritative.

---

## State transitions (run lifecycle)

```
[user turn] → supervisor.route
   ├─ read/enrich  → curator (web-api-mcp / movie-mcp reads) → render_* / propose
   ├─ organize     → organizer (movie-mcp reads → build Proposal, chunk if >50)
   └─ out-of-domain→ decline (FR-005)

Proposal built → status=awaiting_approval → approval_gate.interrupt()
   → AG-UI approval-request emitted → checkpoint (NO token held)

resume (fresh BFF request + new subject token):
   approve → re-validate items → apply valid via movie-mcp (idempotency keys)
           → record ApprovalDecision → status=completed|partially_applied → audit
   reject  → discard → status=rejected → audit
   session ends while pending → status=expired (no writes)

any model/provider/tool failure → status=error → "couldn't complete" AG-UI msg (no silent/unauthorized action)
rate/cost limit exceeded → "try again later" (no action)
```
