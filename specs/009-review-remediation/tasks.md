# Tasks: Full-Repo Review Remediation

**Feature**: `009-review-remediation` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Nature**: security + correctness **remediation** of 9 review findings (#1, #3, #4, #5, #6, #7, #8, #9, #10) + 5 hardening items, across the Expo BFF (server/routes/client) and the `mc-service` Rust backend. #2 (IDOR) is **out of scope** (clarification 2026-06-02). Every fix is **test-first** (FR-023): a test that is RED on current code, then GREEN after the fix; the full existing suite is the regression gate (FR-024). Test/impl pairs use the TDD checkpoint format (Scenarios covered → Verify RED + Expected RED → Verify GREEN + Expected GREEN) per [docs/templates/feature-test-tasks-template.md](../../docs/templates/feature-test-tasks-template.md).

**Path roots**: FE = `frontend/mcm-app/`, BE = `backend/mc-service/`. All commands run from repo root via Nx; RTK active.

---

## Phase 1: Setup

- [ ] T001 Confirm baseline: branch is `009-review-remediation` off a green `main`; RTK active (`rtk gain`); infra up (`pnpm nx up-keycloak infrastructure-as-code` + `pnpm nx up-app infrastructure-as-code` — Keycloak/Redis/Mongo(rs)/mc-service healthy). Record the running endpoints.

**Checkpoint**: environment ready for real-dependency integration tests.

---

## Phase 2: Foundational (Blocking Prerequisite)

- [ ] T002 Capture the pre-change **GREEN baseline** so every later red is attributable: `pnpm nx test mcm-app`, `pnpm nx test:integration mcm-app`, `pnpm nx test mc-service`, `pnpm nx test:integration mc-service`, `pnpm nx lint mcm-app`, `pnpm exec tsc --noEmit` (in `frontend/mcm-app`), `pnpm nx lint mc-service` — record all green.

**Checkpoint**: known-green baseline recorded. ⚠️ No user-story work begins until this passes.

---

## Phase 3: User Story 1 - Links saved on movies can't attack me (Priority: P1) 🎯 MVP

**Goal**: external-reference URLs are restricted to `http(s)` at persistence AND refused at open-time, so a saved `javascript:`/`data:`/arbitrary-scheme link is never actionable (#1).

**Independent Test**: save a movie with a non-web-scheme link → rejected server-side; a pre-existing bad link → not opened client-side; a normal `https` link → opens.

- [x] T003 [US1] Specification-First: update `api-specs/` mc-service OpenAPI for movie create/update — document `400` when an `externalIds[].url` scheme is not `http(s)`, when a required external-id part is empty, or when `(system, uniqueId)` pairs duplicate. **Done when**: schema + error responses describe the validation.
- [x] T004 [P] [US1] **Test (RED)** — add unit tests in `BE/src/domain/external_id.rs` (scheme allowlist) and `BE/src/application/commands/create_movie.rs` (handler rejects non-`http(s)` url, empty external-id parts, duplicates).
  - **Scenarios covered**: US1-AC1 (disallowed scheme rejected at save).
  - **Verify RED**: `pnpm nx test mc-service -- external_id`
  - **Expected RED**: ≥3 failing — `assertion failed: result.is_err()` for a `javascript:` url, an empty `system`, and a duplicate `(system, uniqueId)` (no scheme/duplicate validation on the create path yet).
- [x] T005 [US1] **Impl (GREEN)** — add `BE/src/domain/specifications/http_url.rs` (`HttpUrlSpec`) + register in `specifications/mod.rs`; in `create_movie.rs` and `update_movie.rs` validate each `external_ids[].url` via `HttpUrlSpec`, enforce non-empty parts, and call `has_duplicate_external_ids`.
  - **Prerequisite**: T004 verified RED.
  - **Verify GREEN**: `pnpm nx test mc-service -- external_id`
  - **Expected GREEN**: `0 failures` (e.g., "N passed").
  - **Also run** (regression): `pnpm nx test mc-service`.
- [x] T006 [P] [US1] **Test (RED)** — add `FE/src/utils/unit-tests/http-url.test.ts`.
  - **Scenarios covered**: US1-AC2 (disallowed scheme not opened), US1-AC3 (normal web link opens).
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern http-url`
  - **Expected RED**: suite fails to run — `Cannot find module '@/utils/http-url'` (module absent).
- [x] T007 [US1] **Impl (GREEN)** — add `FE/src/utils/http-url.ts` (`isSafeHttpUrl`) and use it in `FE/src/components/movie-detail.tsx` `openUrl` to refuse non-`http(s)` before `window.open`/`Linking.openURL` (FR-003).
  - **Prerequisite**: T006 verified RED.
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern http-url`
  - **Expected GREEN**: `0 failures` — `javascript:`/`data:`/`file:`/empty unsafe, `http`/`https` safe.
  - **Also run** (regression): `pnpm nx test mcm-app -- --testPathPattern movie-detail`.

**Checkpoint**: malicious link schemes blocked at both layers; US1 independently shippable.

---

## Phase 4: User Story 2 - Only I can affect my session (Priority: P1)

**Goal**: session-affecting endpoints authenticate before any side effect and act only on the caller's own session (#9).

**Independent Test**: unauthenticated request with a victim's session id → no change + 401; authenticated self-logout → works.

- [x] T008 [P] [US2] **Test (RED)** — add integration tests in `FE/tests/integration/auth-session-side-effects.integration.test.ts` against real Redis: (a) `GET /bff-api/auth/user` with a forged `X-Session-Id` and no valid auth → `401`, victim session unchanged; (b) `POST /bff-api/auth/logout` unauthenticated with a victim `X-Session-Id` → victim sessions intact; (c) authenticated self-logout terminates own session.
  - **Scenarios covered**: US2-AC1 (unauth session-status no mutation + rejected), US2-AC2 (unauth logout doesn't terminate victim), US2-AC3 (authed self-logout works).
  - **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern auth-session-side-effects`
  - **Expected RED**: ≥2 failing — (a) victim session deleted/touched despite `401` expectation; (b) victim sessions terminated by an unauthenticated logout (timeout runs pre-auth; logout acts on the forged id).
- [x] T009 [US2] **Impl (GREEN)** — in `FE/src/app/bff-api/auth/user+api.ts` call `requireAuth`+`requireMcUser` **before** `validateSessionTimeout`, validating the session bound to the authenticated identity (not the raw header). In `FE/src/app/bff-api/auth/logout+api.ts`, keep cookie-clearing best-effort but gate `terminateSession`/`logoutUserSessions` on a valid authenticated caller who owns the target session (FR-004/005/006).
  - **Prerequisite**: T008 verified RED.
  - **Verify GREEN**: `pnpm nx test:integration mcm-app -- --testPathPattern auth-session-side-effects`
  - **Expected GREEN**: `0 failures`.
  - **Also run** (regression): `pnpm nx test:integration mcm-app -- --testPathPattern "logout|user"`.

**Checkpoint**: no unauthenticated session side effects; legitimate logout/profile unchanged.

---

## Phase 5: User Story 3 - Abuse protections actually hold (Priority: P2)

**Goal**: rate-limit identity is non-spoofable and never a shared bucket (#4); registration is throttled per source (#8).

**Independent Test**: rotating the forwarding header still trips the login limit; unique-email registration spam from one source is throttled; no global lockout without a proxy.

- [x] T010 [US3] **Blocking spike (gate for T011/T012, research R3)**: determine how the connection/peer remote address is surfaced in the `@expo/server` Node runtime and the trusted header the prod Caddy proxy sets. **Done when**: (a) the derivation precedence (trusted-proxy XFF → connection address) is documented in [research.md](./research.md) R3 with the concrete field/header; AND (b) if the connection address is NOT retrievable, the documented fallback is recorded ("trusted proxy mandatory in non-loopback deployments; direct/no-proxy ⇒ loopback identity only") before T012 begins.
- [x] T011 [P] [US3] **Test (RED)** — add integration tests in `FE/tests/integration/rate-limit-identity.integration.test.ts` against real Redis.
  - **Scenarios covered**: US3-AC1 (rotating forwarding header still trips login limit), US3-AC2 (no shared `'unknown'` bucket / no global lockout).
  - **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern rate-limit-identity`
  - **Expected RED**: ≥2 failing — N+1 logins rotating `X-Forwarded-For` never trip the limit (each gets a fresh key); two clients with no XFF share one counter.
- [x] T012 [US3] **Impl (GREEN)** — rewrite `extractClientIp` in `FE/src/bff-server/rate-limiter.ts` to the trusted-proxy-then-connection-address precedence (config-gated trusted proxy; no `'unknown'` fallback) per R3 (FR-007/008).
  - **Prerequisite**: T010 recorded + T011 verified RED.
  - **Verify GREEN**: `pnpm nx test:integration mcm-app -- --testPathPattern rate-limit-identity`
  - **Expected GREEN**: `0 failures`.
- [x] T012a [US3] Config + docs for the trusted-proxy setting: add a `TRUSTED_PROXY` server-side env var to `FE/src/config/env.ts`, the BFF compose env, and the CLAUDE.md server-side env-var table (Configuration section), with a one-line note that absent ⇒ connection-address identity. **Done when**: the var is wired through `env`, documented, and read by `extractClientIp`. (Pairs with T012; Configuration-in-environment per constitution.)
- [x] T013 [P] [US3] **Test (RED)** — add an integration test in `FE/tests/integration/register-rate-limit.integration.test.ts` against real Redis.
  - **Scenarios covered**: US3-AC3 (single source, unique emails, throttled).
  - **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern register-rate-limit`
  - **Expected RED**: 1 failing — many registrations with unique emails from one source never reach `429` (only per-email limited).
- [x] T014 [US3] **Impl (GREEN)** — add a per-source registration limiter (`checkRegisterIpRateLimit`) in `FE/src/bff-server/rate-limiter.ts` and apply it in `FE/src/app/bff-api/auth/register+api.ts` alongside the existing per-email check (FR-009).
  - **Prerequisite**: T013 verified RED. (Depends on T012 — same file.)
  - **Verify GREEN**: `pnpm nx test:integration mcm-app -- --testPathPattern register-rate-limit`
  - **Expected GREEN**: `0 failures` — `429` after the configured per-source threshold.

**Checkpoint**: brute-force/abuse defenses non-bypassable and lockout-safe.

---

## Phase 6: User Story 4 - My session lasts as long as the policy says (Priority: P2)

**Goal**: enforced idle/absolute timeouts equal the configured windows (#3), still failing safe.

**Independent Test**: idle < idle-window → session survives; idle > window → expired; absolute max reached → expired.

- [x] T015 [P] [US4] **Test (RED)** — add an integration test in `FE/tests/integration/session-ttl.integration.test.ts` against real Redis.
  - **Scenarios covered**: US4-AC1 (idle < window survives), US4-AC2 (idle > window expires), US4-AC3 (absolute max expires).
  - **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern session-ttl`
  - **Expected RED**: 1+ failing — after `createSession` the real Redis TTL on the session key is `600`, not the configured remaining absolute lifetime.
- [x] T016 [US4] **Impl (GREEN)** — in `FE/src/bff-server/cache-service.ts` set the session key TTL to the remaining absolute lifetime (param), refreshed on write/touch; pass `expiresAt`/remaining from `FE/src/bff-server/session-manager.ts`. Keep idle/absolute enforcement in `getValidSession` (fail-safe, FR-010/011/012).
  - **Prerequisite**: T015 verified RED.
  - **Verify GREEN**: `pnpm nx test:integration mcm-app -- --testPathPattern session-ttl`
  - **Expected GREEN**: `0 failures` — TTL ≥ remaining absolute lifetime; idle/absolute breach still deletes.
- [ ] T017 [US4] Regression: existing session-timeout suites stay green — `pnpm nx e2e mcm-app -- tests/e2e/web/session-timeout.spec.ts` (web, fake clock). **Done when**: no new failures vs the T002 baseline.

**Checkpoint**: session lifetime matches policy; fail-safe preserved.

---

## Phase 7: User Story 5 - My data and status are accurate (Priority: P3)

**Goal**: createdAt survives edits (#5); set-default is all-or-nothing (#6); verify-email reports truth (#7); malformed ids are cleanly rejected (#10).

**Independent Test**: per the four scenarios below.

- [x] T018 [US5] Specification-First: update `api-specs/` mc-service OpenAPI — `createdAt` immutable across `PUT` movie; `PATCH` set-default atomic; movie list malformed `cursor` → `400`. **Done when**: documented.
- [x] T019 [P] [US5] **Test (RED)** — add `BE/tests/integration/movie_update_preserves_created_at.rs`.
  - **Scenarios covered**: US5-AC1 (createdAt preserved after edit).
  - **Verify RED**: `pnpm nx test:integration mc-service -- --test movie_update_preserves_created_at`
  - **Expected RED**: 1 failing — `assert_eq!(after.created_at, before.created_at)` fails (createdAt overwritten with edit time).
- [x] T020 [US5] **Impl (GREEN)** — change `BE/src/adapters/mongodb/movie_repository.rs` `update` to a targeted `$set` of mutable fields + `updatedAt`, preserving `createdAt` (research R8).
  - **Prerequisite**: T019 verified RED.
  - **Verify GREEN**: `pnpm nx test:integration mc-service -- --test movie_update_preserves_created_at`
  - **Expected GREEN**: `0 failures` — `createdAt` unchanged, `updatedAt` advanced.
- [x] T021 [P] [US5] **Test (RED)** — add `BE/tests/integration/set_default_atomicity.rs`.
  - **Scenarios covered**: US5-AC2 (foreign/invalid target → prior default retained), US5-AC3 (combined PATCH failure → default unchanged).
  - **Verify RED**: `pnpm nx test:integration mc-service -- --test set_default_atomicity`
  - **Expected RED**: 1+ failing — after a failed set-default on a non-owned/non-existent id, the prior default is cleared (no default remains).
- [x] T022 [US5] **Impl (GREEN)** — in `BE/src/application/commands/set_default_collection.rs` validate target ownership/existence **before** clearing, inside a MongoDB transaction; in `BE/src/api/collections/update.rs` (+`update_collection.rs`) order/compose so a later failure leaves the default unchanged (research R7, FR-014/015).
  - **Prerequisite**: T021 verified RED.
  - **Verify GREEN**: `pnpm nx test:integration mc-service -- --test set_default_atomicity`
  - **Expected GREEN**: `0 failures` — prior default retained on every failed/forbidden attempt.
- [ ] T023 [P] [US5] **Test (RED)** — add `FE/tests/integration/verify-email-outcome.integration.test.ts` using the real Keycloak action-token flow.
  - **Scenarios covered**: US5-AC4 (invalid/expired/used → failure; valid → success).
  - **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern verify-email-outcome`
  - **Expected RED**: 1+ failing — an invalid/expired token yields `{ success: true }` (any 302 ⇒ success).
- [x] T024 [US5] **Impl (GREEN)** — in `FE/src/app/bff-api/auth/verify-email+api.ts` distinguish the genuine-success redirect from Keycloak's error redirect (and/or cross-check `emailVerified` via the service-account Admin API); report success only on true success (FR-016, R5).
  - **Prerequisite**: T010-style R5 capture done + T023 verified RED.
  - **Verify GREEN**: `pnpm nx test:integration mcm-app -- --testPathPattern verify-email-outcome`
  - **Expected GREEN**: `0 failures` — invalid/expired/used ⇒ failure response; valid ⇒ success.
- [x] T025 [P] [US5] **Test (RED)** — add route/unit tests in `FE/tests/app/bff-api/collections/identifier-validation.test.ts`.
  - **Scenarios covered**: US5-AC5 (malformed id → 400, no upstream call).
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern identifier-validation`
  - **Expected RED**: 1+ failing — a `collectionId`/`movieId` containing `/`, `?`, or `%2f` reaches the upstream client / returns a non-400 (raw interpolation).
- [x] T026 [US5] **Impl (GREEN)** — add a shared id validator (`FE/src/bff-server/resource-id.ts`, safe-character whitelist `/^[A-Za-z0-9_-]+$/` — **not** strict 24-hex ObjectId, which 400s the Expo-Router-shadowed `…/movies/filter-options`; see research R6) and apply it in every parameterized route: `FE/src/app/bff-api/collections/[collectionId]/index+api.ts`, `.../movies/index+api.ts`, `.../movies/[movieId]+api.ts`, `.../movies/filter-options+api.ts`, returning `400` via `handleMcApiError` before any upstream call for smuggling ids; forwarding safe-but-unknown ids to mc-service (which 404s) (FR-017).
  - **Prerequisite**: T025 verified RED.
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern identifier-validation`
  - **Expected GREEN**: `0 failures` — malformed id ⇒ `400` at the edge, no upstream call.

**Checkpoint**: data integrity + status accuracy + clean input rejection in place.

---

## Phase 8: User Story 6 - Defensive hardening of the confirmed minor gaps (Priority: P3)

**Goal**: close the 5 lower-severity confirmed gaps (FR-018–FR-022).

**Independent Test**: per the five scenarios below.

- [x] T027 [P] [US6] **Test (RED)** — add `FE/tests/integration/concurrent-session-cap.integration.test.ts`.
  - **Scenarios covered**: US6-AC1 (concurrent logins never exceed max).
  - **Verify RED**: `pnpm nx test:integration mcm-app -- --testPathPattern concurrent-session-cap`
  - **Expected RED**: 1 failing — simultaneous `createSession` calls leave the real Redis session set above the configured max (TOCTOU overshoot).
- [x] T028 [US6] **Impl (GREEN)** — make eviction in `FE/src/bff-server/session-manager.ts` trim-to-cap atomically (evict-to-cap re-check loop, escalate to a Redis Lua script if a race remains) (FR-018, R9).
  - **Prerequisite**: T027 verified RED.
  - **Verify GREEN**: `pnpm nx test:integration mcm-app -- --testPathPattern concurrent-session-cap`
  - **Expected GREEN**: `0 failures` — count never exceeds max.
- [x] T029 [P] [US6] **Test (RED)** — add `BE/tests/integration/list_movies_rejects_bad_cursor.rs`.
  - **Scenarios covered**: US6-AC2 (malformed cursor → 400, not page-1 restart).
  - **Verify RED**: `pnpm nx test:integration mc-service -- --test list_movies_rejects_bad_cursor`
  - **Expected RED**: 1 failing — a malformed `cursor` returns `200` page 1 instead of `400`.
- [x] T030 [US6] **Impl (GREEN)** — make `decode_cursor` return a typed error and map it to `400` in `BE/src/api/movies/list.rs` (+`movie_repository.rs`) (FR-019).
  - **Prerequisite**: T029 verified RED. (Depends on T020 — same repo file.)
  - **Verify GREEN**: `pnpm nx test:integration mc-service -- --test list_movies_rejects_bad_cursor`
  - **Expected GREEN**: `0 failures` — malformed cursor ⇒ `400`.
- [x] T031 [P] [US6] **Test (RED)** — add a unit test in `FE/src/utils/unit-tests/validators.test.ts`.
  - **Scenarios covered**: US6-AC3 (all-criteria password score within range).
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern validators`
  - **Expected RED**: 1 failing — `expect(evaluatePassword(strong).score).toBeLessThanOrEqual(4)` fails (returns 5).
- [x] T032 [US6] **Impl (GREEN)** — return the clamped `score` (0–4) from `evaluatePassword` in `FE/src/utils/validators.ts` (FR-020).
  - **Prerequisite**: T031 verified RED.
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern validators`
  - **Expected GREEN**: `0 failures` — score ≤ 4 for all inputs.
- [x] T033 [P] [US6] **Test (RED)** — add a unit test in `FE/src/bff-server/unit-tests/cache-service.test.ts` using the injectable `RedisLike` fake (unit scope).
  - **Scenarios covered**: US6-AC4 (corrupt cached session → treated as no session).
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern cache-service`
  - **Expected RED**: 1 failing — `getSession` throws `SyntaxError` on a non-JSON stored value instead of returning `null`.
- [x] T034 [US6] **Impl (GREEN)** — wrap `JSON.parse` in `getSession`/`updateSessionActivity`/`getCachedUserProfile` (`FE/src/bff-server/cache-service.ts`) in try/catch; on failure return `null` and delete the corrupt key (FR-021).
  - **Prerequisite**: T033 verified RED. (Depends on T016 — same file.)
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern cache-service`
  - **Expected GREEN**: `0 failures` — corrupt value ⇒ `null`.
- [x] T035 [P] [US6] **Test (RED)** — add unit tests in `BE/src/application/commands/create_movie.rs`/`update_movie.rs`.
  - **Scenarios covered**: US6-AC5 (empty required field rejected).
  - **Verify RED**: `pnpm nx test mc-service -- required_fields`
  - **Expected RED**: 1+ failing — empty `title` or `language` is accepted (no required-field spec).
- [x] T036 [US6] **Impl (GREEN)** — add `BE/src/domain/specifications/required_string.rs` (`RequiredStringSpec`) + `mod.rs`; enforce non-empty `title`/`language` in `create_movie.rs`/`update_movie.rs` (FR-022).
  - **Prerequisite**: T035 verified RED. (Depends on T005 — same handler files.)
  - **Verify GREEN**: `pnpm nx test mc-service -- required_fields`
  - **Expected GREEN**: `0 failures` — empty title/language rejected.

**Checkpoint**: all confirmed minor gaps closed.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [x] T037 [P] Doc sweep: update `api-specs/` for final consistency and any `docs/`/README notes for the behavioral changes (verify-email status, id-validation 400, createdAt immutability, `TRUSTED_PROXY`). **Done when**: docs reflect the new contracts.
- [x] T038 [P] Lint/format/typecheck clean: `pnpm nx lint mcm-app`, `pnpm exec tsc --noEmit` (in `FE`), `pnpm nx lint mc-service` (clippy), `cargo fmt --check` — all clean.
- [ ] T039 Full regression gate (FR-024) per [quickstart.md](./quickstart.md): `pnpm nx test mc-service` + `pnpm nx test:integration mc-service` + `pnpm nx test mcm-app` + `pnpm nx test:integration mcm-app` + `pnpm nx e2e mcm-app` + `pnpm nx e2e:mobile mcm-app`. Expected: all green, no regressions vs T002.
- [ ] T040 `rtk gain` → confirm >80% per-test-run compression (run last; measures the runs above).

---

## Platform Parity Table

This feature is predominantly BFF/backend; most remediations are verified by unit/integration tests (no new UI scenarios). The existing E2E suites are the UI regression gate (T039).

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC2: disallowed link scheme not actionable | N/A — client guard + domain spec are unit-tested; tapping a `javascript:` link to assert non-execution is not reliably assertable in a UI driver | N/A — same justification | N/A |
| US1-AC3: normal web link opens | `movies.spec.ts` (existing movie-detail flow regression) | `movie-edit.yaml` / `movie-add.yaml` (existing regression) | ✅ |
| US2 (#9): unauthenticated session side-effects blocked | N/A — no UI surface; verified by `auth-session-side-effects.integration.test.ts` against real Redis | N/A — same justification | N/A |
| US3 (#4/#8): rate-limit identity + register throttle | N/A — header-spoof/IP-bucket behavior not expressible via UI; integration-tested | N/A — same justification | N/A |
| US4 (#3): session timeout honored | `session-timeout.spec.ts` (existing, fake clock) | `session-timeout.yaml` (existing, manual target) | ✅ |
| US5 (#5): createdAt preserved on edit | N/A — data property, not displayed; mc-service integration-tested | N/A — same justification | N/A |
| US5 (#6): default collection retained on failed set | `collections.spec.ts` (existing default/edit flow regression) | `collection-edit.yaml` (existing regression) | ✅ |
| US5 (#7): verify-email true outcome | N/A — Keycloak action-token flow; integration-tested against real Keycloak | N/A — same justification | N/A |
| US5 (#10): malformed id rejected at edge | N/A — direct malformed request, not a normal UI action; route-tested | N/A — same justification | N/A |
| US6: hardening batch | N/A — unit/integration-tested (no UI surface) | N/A — same justification | N/A |

No `❌ Gap` rows — every UI-observable behavior is covered by an existing flow; non-UI behaviors are justified N/A with unit/integration coverage.

---

## Dependencies & Execution Order

- **Setup (T001) → Foundational (T002)** blocks all stories.
- **T010 is a hard gate**: T011/T012 (and the R5 capture feeding T024) MUST NOT start until T010's outcome (and any fallback) is recorded in research.md R3.
- **User stories** can otherwise proceed in priority order (US1→US6) or in parallel by area; they are independently testable.
- **Same-file sequencing (not parallel):** T014 after T012 (`rate-limiter.ts`); T034 after T016 (`cache-service.ts`); T030 after T020 (`movie_repository.rs`); T036 after T005 (`create_movie.rs`/`update_movie.rs`).
- **Within each story:** the `[P]` test task is written and verified **RED** before its paired implementation task (GREEN).
- **Polish (T037–T040)** after all desired stories complete; T040 last.

### Parallel opportunities

- All `[P]` **RED test** tasks across different files can be written in parallel: T004, T006 (US1); T008 (US2); T011, T013 (US3); T015 (US4); T019, T021, T023, T025 (US5); T027, T029, T031, T033, T035 (US6).
- Implementation tasks in different files/projects can run in parallel across stories (respect the same-file sequencing above).

---

## Implementation Strategy

- **MVP = US1 + US2** (both P1 — the two critical security fixes: stored-XSS and unauthenticated session side-effects). Ship after Phase 4 and validate.
- **Incremental:** add US3, US4 (P2 — abuse + session-timeout), then US5, US6 (P3 — accuracy + hardening), validating independently at each checkpoint.
- Each story is a green increment; run the touched suite after each impl task, the full gate (T039) only at the end.

---

## Completion Checklist

Before marking `009-review-remediation` complete, verify all success criteria from [spec.md](spec.md):

- [ ] **SC-001**: disallowed link schemes 100% non-actionable (web + native, save + open)
- [ ] **SC-002**: 100% of unauthenticated session-affecting requests cause no change
- [ ] **SC-003**: login limit not bypassable by header manipulation; no global lockout
- [ ] **SC-004**: registration throttled per source for unique-email spam
- [ ] **SC-005**: session valid for full configured idle + absolute windows; never usable past expiry
- [ ] **SC-006**: createdAt unchanged after every movie edit
- [ ] **SC-007**: existing default retained on 100% of failed/unauthorized set-default attempts
- [ ] **SC-008**: verify-email outcomes match reality (no false success)
- [ ] **SC-009**: malformed identifiers rejected with a clean client error, no unintended upstream path
- [ ] **SC-010**: every finding has a fail-first test; full pre-existing suite green (no regressions)
- [ ] Platform parity table complete — no ❌ gaps remain
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `pnpm nx test mcm-app` — unit tests pass (≥70% line coverage)
- [ ] `pnpm nx test:integration mcm-app` — integration tests pass
- [ ] `pnpm nx test mc-service` — unit tests pass
- [ ] `pnpm nx test:integration mc-service` — integration tests pass
- [ ] `pnpm nx lint mcm-app` + `pnpm nx lint mc-service` — no lint errors
- [ ] `pnpm nx e2e mcm-app` — web E2E passes
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes (logged-out start between runs)
- [ ] `rtk gain` — >80% token compression confirmed (run last)
