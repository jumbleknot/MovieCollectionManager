# Phase 0 Research & Decisions: Feature 040

All decisions below were settled during the brainstorming session and grounded in a four-track code reconnaissance of the current behavior. No open `NEEDS CLARIFICATION` items remain. Each decision records the concrete anchor so Phase 1/2 can proceed without re-discovery.

---

## Item 1 — Admin disables self-registration

### D1.1 — Source of truth: a new single-document app-settings store
- **Decision**: Persist a global settings document in a new MongoDB collection `app_settings` (single doc, `_id:"global"`), accessed via a new `frontend/mcm-app/src/bff-server/app-settings-store.ts` that mirrors the existing per-user `agent-config-store.ts` (get/upsert), using the shared `getDb()` in `mongo-client.ts`. Field: `allowSelfRegistration:boolean` plus `updatedBy` (Keycloak UUID) + `updatedAt`.
- **Rationale**: The app has no global settings store today; the per-user `agent-config-store.ts` is the proven precedent. App-owned state (chosen over the Keycloak realm flag) because registration does not use Keycloak's self-service page.
- **Alternatives rejected**: (a) Keycloak `registrationAllowed` realm flag — *ineffective*: registration goes through the Keycloak **Admin API** in `register+api.ts`, not the realm self-service page, so the flag would not stop it (it is already `false` in all realm exports). (b) Env var — not runtime-togglable by an admin.

### D1.2 — Default allowed
- **Decision**: Absent document ⇒ `allowSelfRegistration = true`. **Rationale**: preserves today's behavior on fresh deploys (SC-004).

### D1.3 — Admin write endpoint, gated by requireMcAdmin
- **Decision**: `bff-api/admin/settings+api.ts` with `GET` (read full settings) and `PATCH` (set `allowSelfRegistration`), each calling `requireAuth(headers)` then `requireMcAdmin(user)`. This is the **first production use** of `requireMcAdmin` (currently defined-but-unused in `role-check.ts`).
- **Rationale**: Least-privilege; reuses the ready-made admin gate. **Alternatives rejected**: a generic `requireRole` inline check — `requireMcAdmin` already exists and is tested.

### D1.4 — Public registration-status read
- **Decision**: `bff-api/auth/registration-status+api.ts`, unauthenticated `GET → { allowed: boolean }`, exposing only that one boolean.
- **Rationale**: The `(auth)` group (login/register) has no session, so it cannot call the admin-gated endpoint; it needs a public read to hide the entry point (FR-005/FR-006). **Alternatives rejected**: embedding the flag in an existing public bootstrap (`init+api.ts`) — a dedicated, minimal endpoint keeps exposure to exactly one boolean.

### D1.5 — Server-side enforcement in register
- **Decision**: At the top of `register+api.ts` `_post()`, before `createUser`, read the setting; if disabled → 403 typed error (`AuthError` FORBIDDEN-style) + `logger.audit` of the refused attempt.
- **Rationale**: Authoritative even if the client entry point is bypassed (FR-004). Client hiding is convenience only.

### D1.6 — Admin UI + login-screen conditional
- **Decision**: New mc-admin-only screen `app/(app)/admin/settings.tsx` (first admin UI) with a toggle wired to a `use-app-settings.ts` hook (admin GET/PATCH). Route guarded for admin role via the existing `auth-guard`/`protected-route` admin-role param (currently accepted but unused). `login-screen.tsx` hides the "Create Account" `Link` when `use-registration-status.ts` reports disabled; the register route also guards/redirects when disabled.
- **Rationale**: In-app admin control per product decision; design-system components only.

---

## Item 2 — TMDB add: ask ownership + navigate to detail

### D2.1 — New `awaiting_ownership` stage (pure code, off-golden)
- **Decision**: Add an `awaiting_ownership` stage in the add flow in `nodes/organizer.py` `_add()`, **after** curator TMDB enrich and **before** `build_add_proposal`. It emits a `render_selection` Yes/No ("Do you own this movie?"), stashes the candidate + resolved target, and on the next turn sets the ownership boolean. New `GraphState` field(s) + additions to the `_ADD_STATE_RESET` dicts in `graph.py` and `approval_gate.py`. Supervisor keeps the turn routed to `add` while the stage is pending (mirror the existing `awaiting_collection` handling).
- **Rationale**: Reuses the existing multi-turn stage pattern and the existing `render_selection` button surface; adds **no new intent**, so it stays off the golden gate. **Alternatives rejected**: folding ownership into the approval card (product chose a distinct Yes/No step first); using `interrupt()` (that is the single approve/reject surface, not a free-form question).

### D2.2 — Thread `owned` through `to_movie_payload`
- **Decision**: Remove the hardcoded `"owned": True` at `proposals.py:187`; `to_movie_payload()` takes the chosen ownership boolean and sets it (default false to match mc-service). `EnrichedMovieCandidate`/proposal carry the answer.
- **Rationale**: mc-service `CreateMovieDto.owned` is `#[serde(default)]` = **false** and honored as-is; the agent was the only place forcing true. "No" simply stores `owned=false` (still added to the collection; no wishlist routing — out of scope).

### D2.3 — Emit `navigate_to_movie` after successful add
- **Decision**: In `approval_gate.apply_proposal`, capture the created movie's id from the add `ExecOutcome.data` (mc-service returns the created movie DTO), thread `movieId` out, and emit an `AIMessage` tool call `navigate_to_movie(collectionId, movieId)` (constant `NAVIGATE_TO_MOVIE`, already in `UI_ACTION_TOOLS`).
- **Rationale**: The client already dispatches this: `ui-action-tools.tsx` `NAVIGATE_TO_MOVIE_TOOL` authorizes via BFF then `router.push('/collections/{cid}/movies/{mid}')`. Only the agent-side capture+emit is missing. **Alternatives rejected**: client-initiated navigation — breaks the agent-drives-UI contract and default-deny authorization.

---

## Item 3 — Spreadsheet-import reliability (4 fixes)

### D3.1 — Don't silently abandon on an unparsed clarification answer
- **Decision**: In the `graph.py` import-continuation gate (~lines 259–263), when a comma-question answer does not `resolve_option()` against the pending prompt options, **re-ask the pending question** (keep `import_stage` + `import_prompt`) instead of running `_IMPORT_STATE_RESET` and re-classifying as a new intent.
- **Rationale**: `resolve_option` is finicky (numeric/year/substring parsing); a slightly-off answer today discards the whole in-progress import with no message (prime "it just stopped" cause). **Alternatives rejected**: making `resolve_option` looser globally — risks mis-parsing other flows; a targeted re-ask is safer.

### D3.2 — Always surface an outcome (graceful-degradation wrapper)
- **Decision**: Wrap the import node body (in `runtime_nodes.py` `_build_import_node`) analogous to the supervisor's `_degrade_node`, so any exception yields a user-facing "import failed: &lt;reason&gt;" `AIMessage` rather than ending the run with no reply.
- **Rationale**: The import node has no try/except today; a non-transient `invoke_tool` error re-raises and ends the run silently (second "it just stopped" cause). Reason strings must be non-secret.

### D3.3 — Exempt import existing-movie reads from the rate limit
- **Decision**: Pass `skip_rate_limit=True` on the `_finalize` `list_movies` reads (the same exemption writes already got).
- **Rationale**: Default 30 calls/60s; a large multi-collection import paginates many reads, exhausts the limit, `break`s on `ok=False`, and silently under-reports existing movies → wrong dedup (creates duplicates). **Alternatives rejected**: raising the global limit — weakens the guard for other flows.

### D3.4 — Store a transient handle, not the full parsed dataset, across clarification turns
- **Decision**: Persist a transient handle/reference to the parsed spreadsheet (reuse the spreadsheet-mcp transient `store` pattern) in `GraphState` instead of re-serializing the entire `import_context = {tabs, collections}` (every row) on every comma-question turn.
- **Handle-lifetime constraint (FR-016)**: The handle's backing store MUST keep the parsed data valid for the **entire import session** — i.e., across all of its clarification turns, not just the first. If the spreadsheet-mcp transient store's TTL/eviction cannot guarantee session-long validity, the implementation MUST either refresh/extend the entry per turn or checkpoint a minimal **re-parse key** (e.g., the upload handle) that can deterministically re-materialize the parsed data. A handle that can expire mid-session is not acceptable (it would reintroduce the "it just stopped" failure). A multi-turn resolution test guards this.
- **Rationale**: Checkpoint bloat: a large file with many comma titles serializes the whole dataset per turn → slowness / possible checkpoint-size or timeout failure (the "timed out" cause). **Alternatives rejected**: chunking the proposal — orthogonal; the bloat is the per-turn state, not the apply step.

### D3.5 — Out of scope (recorded)
- The `/resume` path dropping `excludedTabs` in `resumeMovieAssistantRun` is a **separate** known bug, explicitly deferred to its own backlog item (per product decision). Not addressed here.

---

## Item 4 — Navigate-to-collection routing (2 sub-bugs)

### D4.1 — Bug (a): stateful `navigate_stage` + stage-anchored disambiguation buttons (pure code)
- **Decision**: Give the navigator a persisted `navigate_stage` (mirroring `search_stage`/`add_stage`/`import_stage`): `navigator._clarify` posts buttons whose `value` is a **bare, stage-anchored token** (like search's bare name), not `"open <name>"`; add a `navigate_stage` continuation guard in `graph.py` (alongside the search/add/import guards ~209–263) so the tap stays in the navigator and actually navigates. New `GraphState` fields `navigate_stage`/`navigate_options` + reset handling.
- **Rationale**: Today the buttons post `"open <name>"`, which the top-level classifier maps to **search** (there is no navigate stage to anchor the tap), so the pick becomes a movie search inside the on-screen collection. This is the exact reported failure. **Alternatives rejected**: an `interrupt()`-based pick — the codebase's other disambiguations are stage-based, keep consistency.

### D4.2 — Bug (b): classifier distinguishes "navigate to &lt;collection&gt; collection" (golden surface)
- **Decision**: Update the `supervisor.py` intent-classifier prompt so an utterance with an explicit navigate cue plus the word "collection" that names an owned collection routes to `navigate` (not `search`); **re-record** the golden cassette `tests/golden/cassettes/us7-intent-search-navigate.json` and obtain **human approval** (FR-023) before merge.
- **Rationale**: `"navigate to test import collection"` inconsistently classifies as search; because navigation never fires, the screen stays anchored to the current collection and every follow-up mis-scopes. Product chose to fix the classifier directly (over a pure-code pre-classifier override) for fidelity to the model surface. **Alternatives rejected**: deterministic pre-classifier override (considered; product chose the classifier + re-record path).

### D4.3 — Anchor/context correctness
- **Decision**: With D4.1+D4.2, navigation actually fires, so `ui_snapshot.collection_id` advances and the "stuck on Movie Collection" symptom resolves as a consequence. A navigate request naming no owned collection yields a navigation-context response (the navigator's clarify/list), not a movie-search failure. No separate "active collection" state is introduced.
- **Rationale**: The stickiness was a *symptom* of navigation never firing, not a separate state bug.

---

## Cross-cutting decisions

- **TDD order**: For each slice, author failing tests first (unit → integration → E2E), then implement. Items 2/3/4 have existing unit/integration suites to extend (`test_navigator.py`, `test_routing.py`, `test_search.py`, `test_import_*`, `test_import_flow.py`).
- **Image rebuilds**: After any change under `agents/` or `mcp-servers/`, rebuild the agent gateway + affected MCP images before containerized E2E (stale image = old code).
- **Golden discipline**: Only Item 4(b) touches a cassette. Items 2 & 3 add no intent and touch no cassette.
- **No mc-service change expected**: `owned` is already honored; confirm with existing mc-service tests rather than modifying the backend.
