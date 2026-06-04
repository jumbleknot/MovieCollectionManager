---
description: "Task list for Clean Expo Router (010)"
---

# Tasks: Clean Expo Router

**Input**: Design documents from `/specs/010-clean-expo-router/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/contract-deltas.md](contracts/contract-deltas.md), [quickstart.md](quickstart.md)

**Tests**: REQUIRED — TDD is non-negotiable per the constitution. Every test task carries a Verify RED; every paired implementation task carries a Verify GREEN.

**Scope**: Frontend/BFF only (`frontend/mcm-app`). No mc-service or `/api-specs` changes (research R4). All commands run from repo root; Nx is the primary invocation path.

**Story independence**: US1, US2, US3 touch disjoint files and can be implemented/tested in any order. US3 is gated by a viability spike (T012) that may descope it without affecting US1/US2.

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Confirm the deterministic baseline before changing anything: bring up infra (`pnpm nx up-keycloak infrastructure-as-code`), build + run the dev BFF container (`pnpm nx docker-build mcm-app`; `docker compose --profile bff-dev up -d`), and record a green baseline run `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` (expect 93/93, ~54s) so any later slowdown/failure is attributable per the CLAUDE.md diagnosing-flakiness guidance.
- [ ] T002 [P] Confirm RTK is active in the shell (`rtk gain` works) per the constitution Token Compression requirement.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: This feature has no shared code prerequisite — the three stories are independent. No foundational code tasks.

**Checkpoint**: Setup green → user stories may begin (in parallel if staffed).

---

## Phase 3: User Story 1 — Movie filter options always reach the correct handler (Priority: P1) 🎯 MVP

**Goal**: Guarantee `GET …/movies/filter-options` is served by its dedicated handler (never the dynamic `[movieId]` handler) and lock it with a regression guard. Keep the permissive `validateObjectId` whitelist.

**Independent Test**: Request a collection's filter options; assert a `FilterOptionsDto`-shaped response from the dedicated handler and that `[movieId]` is never invoked for that path.

- [ ] T003 [US1] Write the routing-guard test (RED) in `frontend/mcm-app/tests/app/bff-api/collections/filter-options-routing.test.ts`. Spec: spec.md#user-story-1 (US1-AC2, US1-AC3). The test drives the route resolution for `…/movies/filter-options` and asserts the dedicated `filter-options+api.ts` handler runs (returns `FilterOptionsDto` keys `genres, contentTypes, rated, languages, decades, ownedMedia, ripQuality`) while the `[movieId]+api.ts` handler is NOT invoked (spy/mock the single-movie path or assert response shape that only filter-options produces).
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern filter-options-routing`
  - **Expected RED**: ≥1 failing — filter-options request resolves to the single-movie handler (or returns a non-`FilterOptionsDto` shape). If it passes immediately, harden the assertion so it would catch the shadowing before proceeding.
- [ ] T004 [US1] Reproduce and fix route precedence (GREEN). Prerequisite: T003 RED. Per research R1: first reproduce the mechanism, then apply the minimal deterministic fix — **(A)** confirm-and-rely on static-wins precedence after a clean rebuild (preferred), else **(B)** restructure so filter-options is not a dynamic sibling (e.g. move to `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/options/index+api.ts` and update `frontend/mcm-app/src/bff-server/mc-service-client.ts` + the consuming hook/screen), else **(C)** defensive delegation in `[movieId]+api.ts` as a last resort. Do NOT re-tighten `validateObjectId` (FR-004).
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern filter-options-routing`
  - **Expected GREEN**: `1 passed` (or all routing-guard cases pass).
- [ ] T005 [US1] Confirm the smuggling-id guard still holds (regression) — the existing `frontend/mcm-app/tests/app/bff-api/collections/identifier-validation.test.ts` must still pass (malformed id → 400 at edge; safe non-ObjectId like `filter-options` forwarded). Update it only if T004 chose option B (path change).
  - **Verify**: `pnpm nx test mcm-app -- --testPathPattern identifier-validation` → all pass.
- [ ] T006 [US1] Web E2E regression for the user-visible outcome: `pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts` — filter chips populate. Expected: previously passing movie tests still pass.

**Checkpoint**: Filter options deterministically routed and guarded; US1 shippable as MVP.

---

## Phase 4: User Story 2 — Every client-side error at the API boundary is diagnosable from logs (Priority: P2)

**Goal**: `handleMcApiError` emits a structured `warn` log for every 4xx, not only 401/403, preserving the 401/403 audit events and redaction.

**Independent Test**: A non-401/403 4xx through the boundary emits exactly one `warn` log with `action` + `statusCode` (+ `requestId`), no secrets/PII; 401/403 still emit `audit`.

- [ ] T007 [US2] Write the 4xx-logging unit test (RED) in `frontend/mcm-app/src/bff-server/unit-tests/mc-api-error.test.ts`. Spec: spec.md#user-story-2 (US2-AC1, US2-AC2, US2-AC3, US2-AC4). Mock `@/bff-server/logger` and assert: (a) a 400 `AuthError` → one `logger.warn` with `{ action, statusCode: 400 }` and no token/PII; (b) an upstream Axios 404/409 → one `logger.warn` with the upstream status; (c) a 401 → `logger.audit('auth_failed')` and a 403 → `logger.audit('access_denied')` (unchanged, not downgraded); (d) a 5xx/unknown → `logger.error` (unchanged).
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern mc-api-error`
  - **Expected RED**: failing on cases (a)/(b) — no `warn` emitted for non-401/403 4xx today.
- [ ] T008 [US2] Extend `handleMcApiError` (GREEN) in `frontend/mcm-app/src/bff-server/mc-api-error.ts`. Prerequisite: T007 RED. After the existing 401/403 audit branches, add a `logger.warn` for any other 4xx (client `AuthError` with `statusCode` 400–499, and upstream `err.response.status` 400–499) carrying `action` + `statusCode` (+ inherited `requestId`); leave 401/403 audit and 5xx `error` paths untouched; rely on logger redaction (no raw id value/body).
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern mc-api-error`
  - **Expected GREEN**: all cases pass.
- [ ] T009 [US2] Regression: run the BFF route unit suites that exercise the error handler — `pnpm nx test mcm-app -- --testPathPattern "bff-api/collections"`. Expected: previously passing route tests still pass (response bodies/status unchanged; only logging added).

**Checkpoint**: Every 4xx at the boundary is self-explaining in logs; US2 shippable independently.

---

## Phase 5: User Story 3 — The server-side API enforces access centrally (Priority: P3)

**Goal**: A single `+middleware.ts` gate rejects unauthenticated protected `/bff-api/*` requests before any handler runs; public routes (incl. token refresh) pass; per-handler authorization remains.

**Independent Test**: Unauthenticated protected request → 401 at the gate (handler not executed); public request → passes; safeguard fails if the gate is disabled.

- [ ] T010 [US3] **Viability spike (gate decision — no RED/GREEN)**. Spec: FR-018. In `frontend/mcm-app/app.json` add `["expo-router", { "unstable_useServerMiddleware": true }]`; add a minimal `frontend/mcm-app/src/app/+middleware.ts` scoped via `unstable_settings.matcher` to `patterns: ['/bff-api/[...path]']` that logs and passes through; rebuild the dev container and confirm it executes for (a) a web fetch and (b) a native HTTP call, and that returning a `Response` short-circuits the handler.
  - **Done when**: middleware execution is observed for `/bff-api/*` on web and native in the dev container AND a returned `Response` short-circuits a handler. **If not achievable → STOP US3, descope to a follow-up (record in plan.md), ship US1+US2.**
- [ ] T011 [P] [US3] Write the public-route allowlist unit test (RED) in `frontend/mcm-app/src/bff-server/unit-tests/bff-route-access.test.ts`. Spec: spec.md#user-story-3 (US3-AC2), FR-012. Assert `isPublicBffRoute()` returns true for `login`, `register`, `verify-email`, `resend-verification`, `init`, `refresh`, and false for `collections`, `collections/.../movies`, `auth/user`, `auth/logout`.
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern bff-route-access`
  - **Expected RED**: module/`isPublicBffRoute` does not exist yet — suite fails to import.
- [ ] T012 [US3] Implement the gate policy (GREEN) in `frontend/mcm-app/src/bff-server/bff-route-access.ts`. Prerequisite: T011 RED. Export `isPublicBffRoute(pathname)` (the allowlist from data-model.md) and a `requireAuthenticatedRequest(headers)`-style decision that reuses `@/bff-server/auth` token extraction/validation to classify authenticated-or-not. Pure, framework-free, unit-testable.
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern bff-route-access` → all pass.
- [ ] T013 [US3] Write the gate-enforcement integration test (RED) in `frontend/mcm-app/tests/integration/bff-gate.integration.test.ts` (real deps — no mocking the gate; jest.integration config). Spec: spec.md#user-story-3 (US3-AC1, US3-AC2, US3-AC4). Assert: unauthenticated `GET /bff-api/collections` → `401` with security headers and the route handler does not run; unauthenticated `POST /bff-api/auth/login` and `/bff-api/auth/refresh` reachable; an authenticated request still passes `requireMcUser`. Prerequisite: T012 (policy helper exists). Written before the middleware is wired so it fails first (TDD).
  - **Verify RED** (before the gate is wired in T014): `pnpm nx test:integration mcm-app -- --testPathPattern bff-gate.integration`
  - **Expected RED**: unauthenticated protected request reaches the handler (no 401 from a gate yet).
- [ ] T014 [US3] Wire the gate (GREEN) in `frontend/mcm-app/src/app/+middleware.ts`: thin delegator that, for protected `/bff-api/*`, returns a `401` `Response` with `securityHeaders()` when unauthenticated, else passes through; public routes always pass; keep the `unstable_settings.matcher` from T010. Prerequisite: T012 (policy) + T013 (verified RED).
  - **Verify GREEN**: `pnpm nx test:integration mcm-app -- --testPathPattern bff-gate.integration`
  - **Expected GREEN**: all pass — unauthenticated protected request now 401s at the gate; public routes still reachable.
- [ ] T015 [US3] Write the gate-coverage safeguard test (RED→GREEN) in `frontend/mcm-app/tests/integration/bff-gate-coverage.integration.test.ts`. Spec: spec.md#user-story-3 (US3-AC5), FR-015. Assert the gate matches all protected `/bff-api/*` route groups (collections, movies, auth/user, auth/logout) — i.e. fails if the matcher is removed/narrowed or `unstable_useServerMiddleware` is disabled.
  - **Verify RED**: temporarily narrow the matcher → `pnpm nx test:integration mcm-app -- --testPathPattern bff-gate-coverage` fails; restore matcher.
  - **Expected GREEN**: with the full matcher, all pass.
- [ ] T016 [US3] Documentation (no RED/GREEN). Spec: FR-017. Update `CLAUDE.md` (the Centralized Access Control note) and `docs/PRD-CleanExpoRouter.md` Issue 3 to record that the BFF now has a centralized pre-route gate, retiring the "Expo Router exposes no global pre-route hook" assumption (with the immutability caveat: gate enforces deny-by-default but does not inject downstream context). **Done when**: both docs reflect the implemented gate and the prior assumption is marked retired.
- [ ] T017 [US3] Web E2E regression against the gate: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`. Expected: 93/93, ~54s — authenticated flows unaffected by the gate; far slower or failing ⇒ investigate as a real regression (CLAUDE.md guidance).

**Checkpoint**: Centralized deny-by-default gate enforced and safeguarded; constitution Centralized Access Control satisfied for the BFF.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T018 [P] Lint + type-check: `pnpm nx lint mcm-app` and `cd frontend/mcm-app && pnpm exec tsc --noEmit`. Expected: no errors.
- [ ] T019 Run the full unit + integration suites: `pnpm nx test mcm-app` (≥70% coverage) and `pnpm nx test:integration mcm-app`. Expected: green.
- [ ] T020 Mobile E2E regression (no new flow): `pnpm nx e2e:mobile mcm-app`. Expected: existing movie/auth flows still pass (gate is server-side/client-agnostic; no gate-specific mobile flow per the 2026-06-03 clarification).
- [ ] T021 Run [quickstart.md](quickstart.md) end-to-end and confirm each user story's checks; then `rtk gain` (>80%).

---

## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC2/AC3: filter options load via the correct handler | movies.spec.ts | movie-search-filter.yaml (regression — same BFF) | ✅ |
| US2-AC1: 4xx at the BFF boundary is logged | N/A — server-side structured logging, not a UI flow (verified by unit test `mc-api-error.test.ts`) | N/A — server-side logging, not a UI flow | N/A |
| US3-AC1: unauthenticated protected request rejected at the gate | bff-gate integration + existing web E2E session behavior | N/A — gate is server-side and client-agnostic; verified by server-side integration test (clarified 2026-06-03) | N/A |

---

## Dependencies & Execution Order

- **Setup (T001–T002)**: first; establishes the deterministic baseline.
- **US1 (T003–T006)**, **US2 (T007–T009)**, **US3 (T010–T017)**: independent; any order / parallel by file (disjoint paths).
  - Within US1: T003 (RED) → T004 (GREEN) → T005/T006.
  - Within US2: T007 (RED) → T008 (GREEN) → T009.
  - Within US3: T010 spike GATE → T011 (unit RED) → T012 (unit GREEN) → T013 (integration RED) → T014 (wire gate → GREEN) → T015 → T016/T017. Test precedes implementation (TDD). If T010 fails, US3 is descoped.
- **Polish (T018–T021)**: after the desired stories are complete.

### Parallel opportunities

- T002 ∥ T001-followups; US1, US2, and US3 (post-spike) run in parallel across disjoint files; T011 is `[P]` (own new file). T018 lint/type-check `[P]`.

---

## Implementation Strategy

- **MVP**: Setup → US1 (deterministic filter-options routing + guard). Ship/demo.
- **Increment 2**: US2 (observable 4xx boundary) — small, high-leverage, independent.
- **Increment 3**: US3 (centralized gate) — gated by the T010 viability spike; descope cleanly to a follow-up if the alpha capability is unusable, without blocking US1/US2.

---

## Completion Checklist

Before marking `010-clean-expo-router` complete, verify all success criteria from [spec.md](spec.md):

- [ ] **SC-001**: Filter options load on 100% of attempts; zero filter-options requests served by the wrong handler (T003/T004/T006).
- [ ] **SC-002**: 100% of boundary 4xx produce a diagnostic log entry (T007/T008).
- [ ] **SC-003**: A boundary client-error is attributable to route + status from logs alone (T008).
- [ ] **SC-004**: 100% of protected routes reject unauthenticated requests at the gate (handler not run); 0 public routes (incl. refresh) blocked (T013 test, T014 impl) — or US3 descoped per T010.
- [ ] **SC-005**: No regressions — web E2E (93), mobile E2E, unit, integration all green (T017/T019/T020).
- [ ] **SC-006**: 0 secrets/tokens/session-ids/PII in any added log output (T007 assertions).
- [ ] Platform parity table complete — no ❌ gaps remain
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `pnpm nx test mcm-app` — unit tests pass (≥70% line coverage)
- [ ] `pnpm nx test:integration mcm-app` — integration tests pass
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `pnpm nx e2e mcm-app` — web E2E passes
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes (logged-out start between runs)
- [ ] `rtk gain` — >80% token compression confirmed (run last)
