# Feature Specification: Multi-Agent Conversational Assistant (Phase 1 MVP)

**Feature Branch**: `012-multi-agent-mvp`

**Created**: 2026-06-05

**Status**: US1–US3 Implemented (2026-06-09 — GREEN web + mobile; SC-001…SC-011 met. See [tasks.md](tasks.md) Completion Checklist + [implementation-review.md](implementation-review.md)). **US4 (Query your collection) added 2026-06-09 — in progress (tasks.md T071; SC-012 pending).**

**Input**: User description: "docs\PRD-AddMultiAgent.md"

## Overview

Add a conversational assistant that lets a user manage their movie collections by talking to it in natural language ("find the rest of the Dune films and add them to my Sci-Fi collection", "filter my wishlist to 1980s") instead of only using forms. The assistant discovers and enriches movie metadata, proposes changes, and — after the user explicitly approves each change — applies it. It works identically on web and mobile, acts strictly with the calling user's own permissions, and adds value **without changing any existing screen, login flow, or collection/movie behavior**.

This feature is **Phase 1 (Orchestration MVP) only**. Long-term personalization memory and feedback-driven learning are deliberately deferred to later, separately-specified features.

## Clarifications

### Session 2026-06-06

- Q: Where should the conversational assistant live in the app (web + mobile)? → A: An app-wide overlay/dock (chat panel reachable from any screen via a persistent entry point), so it can read the current screen for context-aware references.
- Q: For multi-item organize requests (US2), how should the human-approval gate work? → A: Single batch approval with per-item visibility (the user sees every intended change in one preview and approves/rejects the batch as a whole).
- Q: When should an unapproved proposal expire (abandonment safety)? → A: Tied to the user's authenticated session — a pending proposal expires when the session ends.
- Q: What authorization is required at the moment a write is approved? → A: In-session approval is sufficient (no step-up re-authentication); each approval is still individually recorded and constrained to the user's own permissions.

### Session 2026-06-06 (round 2)

- Q: If the underlying collection changed between proposal and approval, what happens at apply time? → A: Re-validate each item against current state on approval; skip items that no longer apply (duplicate/now-missing), surface what changed, and apply only the still-valid items (do not force, do not abort the whole batch).
- Q: Which collections may the assistant act on for this MVP? → A: Anything the user can per the existing access model — read on owned + shared-to-user collections, write where the user is owner or contributor, denied as viewer — identical to the direct API.
- Q: Should assistant conversations be rate-limited / cost-guarded? → A: Yes — a per-user request rate limit plus a per-user/session cost ceiling; exceeding it returns a friendly "try again later" rather than unbounded spend.
- Q: Should a single organize proposal cap how many items it changes at once? → A: Yes — a single batch is capped at a bounded number of items (~50); larger requests are split into sequential approved batches.

### Session 2026-06-06 (round 3)

- Q: What is the assistant's write scope for this MVP? → A: Movie operations (add/update/remove) within collections, **plus** creating a new collection when the named target does not yet exist. Renaming or deleting whole collections is out of scope for the MVP (stays in the existing forms).
- Q: How should "wishlist" be modeled? → A: As a user-named collection — no separate entity or behavior; the assistant treats it like any other collection.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enrich and add a movie by conversation (Priority: P1)

A signed-in user opens the assistant and types a request to add a specific film to one of their collections (e.g., "Add the original *Blade Runner* to my Sci-Fi collection"). The assistant looks up the canonical movie details from an external metadata source, shows the user a rich preview of what it found and exactly what it intends to save, and asks for confirmation. Nothing is written until the user approves. On approval, the movie is added to the collection and the result is shown inline in the conversation.

**Why this priority**: This is the headline capability and the smallest end-to-end slice that proves the whole pattern — natural-language understanding, external enrichment, a proposed change, the human-approval gate, and a real authorized write. Delivered alone, it is a usable, valuable assistant.

**Independent Test**: From a logged-in session, ask the assistant to add a named movie to one of the user's collections; verify a preview + approval prompt appears, that no movie exists in the collection before approval, and that the movie appears (with enriched metadata) only after the user approves.

**Acceptance Scenarios**:

1. **Given** a signed-in user who owns a "Sci-Fi" collection, **When** they ask the assistant to add a specific named film to it, **Then** the assistant presents enriched details and an explicit approval prompt, and no change is persisted yet.
2. **Given** a pending add proposal, **When** the user approves it, **Then** the movie is added to the collection exactly as it would be via the existing add-movie form, and the assistant confirms inline.
3. **Given** a pending add proposal, **When** the user rejects or ignores it, **Then** no movie is added and the collection is unchanged.
4. **Given** the same request submitted twice (e.g., a retry after a network hiccup), **When** both are approved, **Then** the movie is added only once (no duplicate).
5. **Given** a user who does not have permission to modify the target collection, **When** their assistant attempts the add, **Then** it is denied exactly as a direct API attempt would be, and nothing is written.
6. **Given** a user who asks to add a movie to a collection name that does not yet exist, **When** they confirm, **Then** the same approval preview shows both creating the new collection and adding the movie, and on approval both are applied; rejecting writes neither.
7. **Given** an add request whose title matches several films (a franchise/remake), **When** the assistant offers the matches and the user picks one — by ordinal ("the first one"), by year ("the 2003 one"), or by re-typing the title — **Then** the assistant resolves that single film and proceeds to the same enriched preview + approval prompt, carrying forward the collection the user originally named.
8. **Given** an add request that names no collection or a generic target ("add it to my collection"), **When** the user has a default collection, **Then** the assistant targets that default collection in the preview; **When** the user has no default collection, **Then** the assistant asks which collection to use (listing the user's collections) and never silently creates an unintended one.
9. **Given** a completed (approved or rejected) add, **When** the user makes an unrelated next request in the same conversation, **Then** no leftover state from the finished add (offered options, prior title, pending target) influences it.

---

### User Story 2 - Organize a collection by conversation (Priority: P2)

A signed-in user asks the assistant to reorganize a collection in one instruction (e.g., "Review my wishlist for anything I've marked as owned, add them to my default collection and remove them from wishlist"). The assistant plans the set of updates/removals, presents the proposed batch of changes for the user to review, and applies them only after approval. The user can see, before approving, exactly which movies will change and how.

**Why this priority**: Extends the assistant from single-item adds to multi-item organization — the second-most-requested workflow — while reusing the same plan → preview → approve → apply safety pattern. Valuable on its own but builds on the P1 gate.

**Independent Test**: From a logged-in session with a populated collection, ask the assistant to perform a multi-item reorganization; verify the proposed batch is shown for review, that the collection is unchanged until approval, and that after approval the collection matches the proposed plan.

**Acceptance Scenarios**:

1. **Given** a user with a populated collection, **When** they ask for a multi-item reorganization, **Then** the assistant presents the full set of intended changes for review before any are applied.
2. **Given** a proposed batch of changes, **When** the user approves, **Then** all changes are applied with the user's own permissions and the result is summarized inline.
3. **Given** a proposed batch where the user lacks permission for some items, **When** the assistant attempts to apply, **Then** unauthorized items are denied identically to direct API behavior and are reported back, without silently skipping the approval gate.

---

### User Story 3 - Context-aware reference to the current screen (Priority: P3)

While viewing a specific collection or movie, the user gives the assistant an instruction that references "this" (e.g., "add this to my wishlist") without naming the target. The assistant resolves the target from the screen the user is currently on, then proceeds through the normal preview-and-approve flow.

**Why this priority**: A convenience that makes the assistant feel native and reduces friction, but the assistant is fully usable without it (the user can always name the target explicitly). Lowest priority of the MVP slices.

**Independent Test**: While on a specific collection screen, issue an instruction using "this"; verify the assistant correctly resolves the on-screen collection as the target and that the normal approval flow applies.

**Acceptance Scenarios**:

1. **Given** a user viewing a specific collection, **When** they say "add \<movie\> to this", **Then** the assistant resolves the target as the currently-viewed collection and proceeds to the approval prompt.
2. **Given** a user on a screen with no resolvable target, **When** they use an ambiguous reference, **Then** the assistant asks the user to clarify the target rather than guessing.

---

### User Story 4 - Query your collection by conversation (Priority: P2)

A signed-in user asks read-only questions about their **own** collections — how many movies are in one, what's in it, whether a specific movie is already in it, and filtered variants ("how many sci-fi", "show my 1980s movies", "which ones do I own") — and gets an inline answer. Nothing is written; the assistant reads only what the user could already see, with the user's own permissions.

**Why this priority**: Reading your own library is the natural complement to add/organize — the common "do I already have this?" before adding, and "what's in here?" while browsing. It reuses the existing read path and context-resolution and adds **no** new write surface, so it is low-risk and high-value. (Un-deferred 2026-06-09 after live testing: users asked "how many movies are in my collection" and "find \<title\> in this collection" and the assistant — having no read path — declined or mis-searched the external source.)

**Independent Test**: From a logged-in session, ask "how many movies are in \<collection\>", "is \<title\> in my \<collection\>", and a filtered "how many \<genre\> in \<collection\>"; verify each returns an accurate inline answer read from the user's own collection (not an external lookup), and that a movie not present is reported as "not in your collection" — distinct from an external "no match".

**Acceptance Scenarios**:

1. **Given** a user with a populated collection, **When** they ask "how many movies are in \<collection\>", **Then** the assistant replies with the exact count read from that collection (never an external source — FR-022).
2. **Given** a user, **When** they ask "what's in \<collection\>" / "list my \<collection\>", **Then** the assistant shows the collection's movies inline as a bounded list with a "showing N of \<total\>" indicator when larger.
3. **Given** a user, **When** they ask "do I have \<title\> in \<collection\>" and the movie **is** present, **Then** the assistant shows that movie's details inline; **When** it is **not** present, **Then** the assistant says it isn't in that collection — distinct copy from a "not found on the external source".
4. **Given** a user, **When** they ask a filtered query ("how many \<genre\>", "show my \<decade\> movies", "which are marked owned"), **Then** the assistant answers using the same filter dimensions the existing on-screen filters expose, scoped to the resolved collection.
5. **Given** a query that names no collection or uses "this"/"my collection", **Then** the assistant resolves the target as an add does — the current on-screen collection, else the user's default — and asks which collection only when it genuinely cannot resolve one (FR-014).
6. **Given** a query for a collection the user cannot access, **Then** the read is denied identically to a direct API read (no information leak), exactly as add/organize are (FR-011).
7. **Given** a bare "look up \<title\>" with no in-collection signal, **Then** the assistant treats it as an external enrich-to-add lookup (US1), **not** a collection read — preserving the add flow.

---

### Edge Cases

- **No match / ambiguous title**: When external lookup returns no result or several equally-likely matches, the assistant surfaces the options (or a "not found") and does not fabricate metadata or write anything.
- **Approval abandoned**: If a user starts a request but never approves (closes the app, switches device), the pending proposal does not auto-apply and expires safely; no change is persisted.
- **Long / resumed conversation**: A conversation that pauses for a long time at an approval prompt can be resumed and approved later without losing the proposed change.
- **Provider/assistant failure**: If the underlying reasoning or external lookup fails, the assistant returns a clear "couldn't complete that" message and never performs a silent or partial unauthorized action.
- **Permission changes mid-conversation**: If the user's access to the target collection is revoked between proposal and approval, the write is denied at apply time exactly as a direct API call would be.
- **State drift between proposal and approval**: If the underlying collection changed after the proposal was built (a movie was already added via the form, or the collection was deleted), the assistant re-validates each item at approval time, skips items that no longer apply, surfaces what changed, and applies only the still-valid items — it neither forces a conflicting write nor silently discards the whole batch.
- **Oversized organize request**: If a request would change more items than a single batch allows, the assistant splits it into sequential batches, each individually previewed and approved.
- **Rate / cost limit reached**: If a user exceeds the assistant request rate limit or their cost ceiling, the assistant returns a friendly "try again later" message and performs no action.
- **Out-of-domain requests**: When asked to do something outside movie-collection management (general chit-chat, browsing the open web, running code), the assistant declines and explains its scope.
- **Mobile approval surface**: The approval prompt and inline results render and are actionable on mobile, not only on web.

## Requirements *(mandatory)*

### Functional Requirements

**Conversation & assistance**

- **FR-001**: A signed-in user MUST be able to issue movie-collection requests to the assistant in natural language and receive responses inline in a conversational surface. The assistant MUST be presented as an app-wide overlay/dock reachable from any screen via a persistent entry point (not a single isolated screen), so that context-aware references (FR-013) can resolve against the screen the user is currently viewing.
- **FR-002**: The assistant MUST be able to discover and enrich movie metadata from an external metadata source (read-only) to support add/enrich requests.
- **FR-002a**: When an add lookup returns several equally-likely matches, the assistant MUST offer them and resolve the user's subsequent pick — by ordinal ("the first one"), by year ("the 2003 one"), or by re-typed title — against the offered options, then continue the same add (preserving the collection the user originally named). A pick it cannot unambiguously resolve MUST re-ask rather than guess (FR-014).
- **FR-003**: The assistant MUST present its findings and proposed changes to the user as a reviewable preview before any change is made.
- **FR-004**: The assistant MUST render results inline (e.g., a movie preview, a collection summary, a wishlist) within the conversation.
- **FR-005**: The assistant MUST be confined to the movie-collection domain and MUST decline requests outside that domain.
- **FR-005a**: The assistant's write scope for this MVP is movie operations (add/update/remove) within collections, plus creating a new collection when the named target does not yet exist (HITL-gated like any other write). Renaming or deleting whole collections is out of scope and remains in the existing forms; "wishlist" is treated as ordinary user-named collections, not a distinct concept.

- **FR-005b**: When an add names no collection or uses a generic reference ("my collection", "my list"), the assistant MUST resolve the target to the user's existing **default** collection (the one the user has marked default, per FR-009). If the user has no default collection, the assistant MUST ask which collection to use (FR-014) and MUST NOT create a collection the user did not explicitly name (no literal "my collection" collection).

**Human approval (HITL) gate**

- **FR-006**: Every change the assistant makes to domain data (adding/updating/removing a movie, or creating a new collection per FR-005a) MUST require explicit user approval before it is applied. For a multi-item request, the assistant MUST present the full set of intended changes as a single batch preview with every item individually visible, and the user approves or rejects the batch as a whole. Creating a collection as the target of an add request MUST be surfaced in the same preview as the movie addition(s).
- **FR-006a**: Approving a change requires only an active authenticated session; no step-up re-authentication is required per write. Each approval MUST still be individually recorded (FR-017) and constrained to the user's own permissions (FR-010).
- **FR-007**: No data change MUST occur without a recorded approval; rejecting or ignoring a proposal MUST leave data unchanged.
- **FR-008**: A pending proposal MUST be resumable while the user's authenticated session remains active and MUST NOT auto-apply if abandoned. A pending proposal expires (without writing) when the user's session ends.
- **FR-009**: Submitting the same change more than once (e.g., a retry) MUST result in the change being applied at most once (no duplicate writes).
- **FR-009a**: On approval, the assistant MUST re-validate each proposed change against current domain state. Items whose preconditions no longer hold (now-duplicate, target no longer exists) MUST be skipped and reported; the remaining still-valid items MUST be applied. The whole batch MUST NOT be aborted solely because some items drifted, and conflicting writes MUST NOT be forced.
- **FR-009b**: A single batch proposal MUST be bounded to a configured maximum number of items; a request exceeding it MUST be split into sequential batches, each independently previewed and approved (FR-006).

**Acting as the user (authorization)**

- **FR-010**: The assistant MUST act strictly with the calling user's own permissions and MUST NOT be able to perform any action the user could not perform directly.
- **FR-011**: When the user is not authorized for a target collection or movie, the assistant's attempt MUST be denied identically to a direct API attempt (same outcome, no information leak about resources the user cannot access).
- **FR-012**: The assistant MUST NOT act on behalf of other users or perform administrative actions beyond the calling user's authority.
- **FR-012a**: The assistant's reachable collections are exactly those the calling user can reach directly under the existing access model: it may read collections the user owns or that are shared with them, write to collections where the user is owner or contributor, and MUST be denied where the user holds only viewer access — identical in outcome to the direct API. The assistant is not restricted to owned collections.

**Context awareness**

- **FR-013**: The assistant MUST be able to resolve "this"/"current" references from the screen the user is currently viewing when a target is not named explicitly.
- **FR-014**: When a referenced target cannot be unambiguously resolved, the assistant MUST ask the user to clarify rather than guess.

**Cross-platform parity**

- **FR-015**: All assistant capabilities — conversation, previews, approval prompts, and inline results — MUST behave identically on web and mobile.

**Safety, privacy & observability**

- **FR-016**: The user's authentication credentials/tokens MUST NEVER be stored in conversation state, assistant memory, logs, or traces (verifiable by an automated scan).
- **FR-017**: Every approved change MUST be recorded in an audit trail capturing who approved what and when.
- **FR-018**: On reasoning, lookup, or provider failure, the assistant MUST degrade gracefully to a clear "couldn't complete" message and MUST NEVER perform a silent or unauthorized action.
- **FR-019**: The assistant feature MUST be independently disableable (kill switch) without affecting any existing app functionality.
- **FR-020**: Per-conversation operating cost and responsiveness MUST be observable so they can be governed against configured budgets.
- **FR-020a**: The assistant MUST enforce a per-user request rate limit and a per-user/session cost ceiling. When either is exceeded, the assistant MUST return a friendly "try again later" response and perform no action — never unbounded spend.

**Additive constraint**

- **FR-021**: Adding the assistant MUST require zero changes to existing client screens, sign-in/session flows, or existing collection/movie behavior; all current flows MUST continue to work unchanged.
- **FR-022**: The assistant MUST NOT become a source of truth for collection/movie data; current collection/movie state MUST always come from the existing domain service.

**Querying your own collection (US4)**

- **FR-023**: The assistant MUST be able to answer **read-only** questions about the user's own collections — count, list, find-a-movie-by-title, and filtered variants (by the same dimensions the existing movie filters expose: genre, decade, owned, language, …) — reading current state from the existing domain service (never an external source, never the assistant's own memory — FR-022). These reads MUST respect the user's own permissions identically to a direct API read (FR-010/FR-011) and MUST NOT write or require an approval gate. Counts MUST be served by the domain service (an efficient server-side count), not by fetching and counting every movie client-side.
- **FR-024**: The assistant MUST distinguish a **collection read** ("how many…", "what's in…", "find/look up \<title\> **in my collection**", "do I have…") from an **external enrich-to-add** lookup ("look up/add \<title\>"). A request it cannot unambiguously classify MUST ask the user to clarify (FR-014) rather than guess. A movie absent from the user's collection MUST be reported as not-in-your-collection, distinct from an external "no match".

### Key Entities *(include if feature involves data)*

- **Conversation (thread)**: A single user's ongoing dialogue with the assistant. Holds the in-session working context — recent turns, the current plan, pending proposals, and the resolved on-screen target. Scoped to one user; isolated from domain data; lives only for the duration of the user's authenticated session and is purged when the session ends.
- **Proposal**: A concrete change (or batch of changes) the assistant intends to make, awaiting the user's approval. A multi-item proposal lists every item for review and is approved/rejected as a whole, bounded to a configured maximum item count (oversized requests split into sequential batches). Each item is re-validated against current domain state at approval time. Has a status (pending, approved, rejected, expired) and a carried-forward identity so a retry can't duplicate it; expires when the user's session ends.
- **Approval decision**: The user's recorded accept/reject of a proposal, with timestamp and actor, forming the audit trail.
- **Collection** *(existing domain entity, referenced not redefined)*: The user's named movie collection. The assistant may target an existing one or, per FR-005a, propose creating a new one as the target of an add; "wishlist" is simply a collection the user named that way — there is no distinct entity. The assistant is never the source of truth for collections (FR-022).
- **Enriched movie candidate**: Read-only movie metadata fetched from the external source to populate a proposal preview; not persisted unless the corresponding proposal is approved.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can add, enrich, and organize movies entirely through conversation on **both web and mobile**, with identical behavior.
- **SC-002**: **100%** of assistant-initiated creates/updates/deletes pass through explicit user approval before execution; **0** changes occur without a recorded approval.
- **SC-003**: The assistant never performs an action the user could not perform directly — verified by tests where an unauthorized user's assistant attempt is denied with the same outcome as the direct API.
- **SC-004**: **No** user authentication token is ever found in conversation state, assistant memory, traces, or logs — confirmed by an automated scan in the quality gate.
- **SC-005**: Adding the assistant requires **zero** changes to existing client screens, sign-in/session flows, or domain behavior — verified by the existing end-to-end regression suite staying green.
- **SC-006**: A duplicate-submission (retry) of the same approved change results in exactly **one** persisted change, **zero** duplicates.
- **SC-007**: A proposal abandoned at the approval step results in **zero** data changes and is safely expired no later than the end of the user's session.
- **SC-008**: Per-conversation cost and 95th-percentile responsiveness stay within configured budgets and are visible in observability.
- **SC-009**: The assistant can be disabled via its kill switch with **no** impact on any existing app functionality.
- **SC-010**: When a proposal is approved after the underlying collection drifted, only still-valid items are applied, drifted items are reported, and **zero** duplicate or conflicting writes occur.
- **SC-011**: A user exceeding the assistant rate limit or cost ceiling is stopped with a friendly message and **zero** action performed, while existing (non-assistant) app functionality remains unaffected.
- **SC-012**: A user can ask — on **both web and mobile** — how many movies are in a collection, what's in it, whether a specific movie is in it, and filtered variants, and receive an **accurate** inline answer read from their own collection (counts served by an efficient server-side count, not a client-side full scan). A movie not in the collection is reported as not-in-your-collection; a collection the user cannot access is denied identically to the direct API; and a bare external "look up \<title\>" still routes to the add/enrich flow (zero regression to US1).

## Assumptions

- **Scope is Phase 1 (Orchestration MVP) only.** Per-user long-term personalization memory and any feedback-driven/reinforcement learning are explicitly out of scope and will be specified as separate later features (each preceded by its own constitution amendment).
- **Existing substrate is reused.** The authenticated backend-for-frontend, the movie-collection domain service (with its existing role- and collection-level access control), and the documented agent-UI architecture already exist and are reused unchanged; this feature is purely additive on top of them.
- **Two specialist roles under a router.** The MVP delivers a discovery/enrichment role (read-only external lookups) and an organization role (gated writes), coordinated by a routing supervisor that performs no domain actions itself. This is taken as a given from the PRD and is treated as design detail for the plan.
- **External metadata source.** A third-party movie metadata service (e.g., TMDB/IMDB-class) is available for read-only enrichment; the specific provider is a plan-time choice.
- **HITL batching (clarified 2026-06-06).** For multi-item organization (US2), the assistant presents the full batch for a single review with per-item visibility; the user approves or rejects the batch as a whole. Per-item-deselect approval is explicitly out of scope for this MVP.
- **Approval authorization (clarified 2026-06-06).** Approving a change happens within an active authenticated session and that is sufficient authorization — no step-up re-authentication per write. Each approval is individually recorded and constrained to the user's own permissions. Step-up re-auth, if ever wanted, is a later hardening feature.
- **Conversation retention (clarified 2026-06-06).** Conversation/working state and pending proposals are transient assistant state (not domain data), scoped to the user's authenticated session and purged when the session ends; not subject to domain data-retention rules.
- **Model strategy.** The specific reasoning models/tiers per role are a plan-time, environment-configurable choice and are not pinned by this spec; defaults follow the project's tiered, provider-abstracted strategy.
- **Batch cap default (clarified 2026-06-06).** The single-batch item limit is configurable; a default of ~50 items per batch is assumed for the plan (aligned with the domain service's movie pagination batch size). Larger organize requests are chunked into sequential approved batches.
- **Rate / cost limits default (clarified 2026-06-06).** The per-user assistant request rate limit and per-user/session cost ceiling are configurable; concrete thresholds are a plan-time choice, reusing the existing rate-limiting and budget-observability mechanisms where possible.
- **DAC scope (clarified 2026-06-06).** The assistant operates on any collection the calling user can reach directly (owned or shared-to-user), with writes allowed for owner/contributor and denied for viewer — never restricted to owned-only and never exceeding the user's own access.
- **Conflict handling (clarified 2026-06-06).** Approval-time re-validation is non-fatal per item: drifted items are skipped and reported, valid items proceed; the batch is not aborted wholesale and conflicting writes are not forced.
- **Write scope (clarified 2026-06-06).** Assistant writes are movie-level (add/update/remove) plus create-collection-if-missing; collection rename/delete is out of scope for the MVP. "Wishlist" is user-named collection, introducing no new entity.

## Dependencies

- Existing authenticated backend-for-frontend as the security boundary and sole identity broker.
- Existing movie-collection domain service enforcing role-based and collection-level access control (the assistant relies on it to deny unauthorized actions).
- An external movie-metadata provider for read-only enrichment.
- The project constitution's AI Agents Development Principles (additive, no domain logic in agents, identity propagation as the user, human-in-the-loop for writes, bounded-context isolation, observability/kill-switch governance).

## Out of Scope (this feature)

- Per-user long-term/semantic personalization memory that learns preferences across sessions (deferred — requires constitution amendment A1).
- Feedback-driven or reinforcement-learning behavior change (deferred — requires constitution amendment A2; online/autonomous learning in production is prohibited).
- Any capability outside the movie-collection domain (general chat, open-web browsing beyond the metadata lookup, code execution).
- Autonomous writes that bypass the human-approval gate.
- Cross-user or administrative actions on behalf of others, and shared agent memory across users.
- Renaming or deleting whole collections via the assistant (collection lifecycle beyond create-if-missing stays in the existing forms).
- **Open-ended Q&A / recommendation / ranking over the user's collection beyond count·list·find·filter** — e.g. "what's the longest movie I own", "recommend something from my Sci-Fi", "sort my wishlist by rating". Structured reads (count, list, find-by-title, filtered-by the existing dimensions) are now **in scope as US4**; free-text analysis, recommendations, and sort/aggregation beyond a filtered count remain deferred to a later feature. *(US4 un-deferred 2026-06-09; the read-only-query slice of the prior deferral is now a User Story above.)*
