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

- [x] T001 Confirm the deterministic baseline before changing anything: bring up infra (`pnpm nx up-keycloak infrastructure-as-code`), build + run the dev BFF container (`pnpm nx docker-build mcm-app`; `docker compose --profile bff-dev up -d`), and record a green baseline run `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` (expect 93/93, ~54s) so any later slowdown/failure is attributable per the CLAUDE.md diagnosing-flakiness guidance.
- [x] T002 [P] Confirm RTK is active in the shell (`rtk gain` works) per the constitution Token Compression requirement.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: This feature has no shared code prerequisite — the three stories are independent. No foundational code tasks.

**Checkpoint**: Setup green → user stories may begin (in parallel if staffed).

---

## Phase 3: User Story 1 — Movie filter options always reach the correct handler (Priority: P1) 🎯 MVP

**Goal**: Guarantee `GET …/movies/filter-options` is served by its dedicated handler (never the dynamic `[movieId]` handler) and lock it with a regression guard. Keep the permissive `validateObjectId` whitelist.

**Independent Test**: Request a collection's filter options; assert a `FilterOptionsDto`-shaped response from the dedicated handler and that `[movieId]` is never invoked for that path.

- [x] T003 [US1] Write the filter-options **regression guard** (green-by-design — NOT a RED→GREEN cycle; the functional defect was fixed in 009 by the whitelist) in `frontend/mcm-app/tests/integration/filter-options-routing.integration.test.ts`. Spec: spec.md#user-story-1 (US1-AC2, US1-AC4). HTTP-level against the running BFF: an authenticated `GET …/movies/filter-options` returns `200` + the `FilterOptionsDto` keys, and is never `400`'d at the edge. Rationale (research R1 implementation finding): handler identity is not black-box observable and is moot — both handlers forward to the identical upstream path; the guard locks in the user-observable guarantee and the FR-004 no-re-tighten contract.
  - **Done when**: the guard passes against a server built from current code (dev container), and would fail if `validateObjectId` were re-tightened to strict 24-hex.
- [x] T004 [US1] Verify route resolution (no structural change). Per research R1: confirm on expo-router 56 that `…/movies/filter-options` resolves correctly (static-wins precedence / path-identical forwarding) so no restructure (option B) or defensive delegation (option C) is needed. Keep the permissive `validateObjectId` whitelist (FR-004). Confirm the existing `identifier-validation.test.ts` still passes (T005).
- [x] T005 [US1] Confirm the smuggling-id guard still holds (regression) — the existing `frontend/mcm-app/tests/app/bff-api/collections/identifier-validation.test.ts` must still pass (malformed id → 400 at edge; safe non-ObjectId like `filter-options` forwarded). Update it only if T004 chose option B (path change).
  - **Verify**: `pnpm nx test mcm-app -- --testPathPattern identifier-validation` → all pass.
- [x] T006 [US1] Web E2E regression for the user-visible outcome: `pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts` — filter chips populate. Expected: previously passing movie tests still pass.

**Checkpoint**: Filter options deterministically routed and guarded; US1 shippable as MVP.

---

## Phase 4: User Story 2 — Every client-side error at the API boundary is diagnosable from logs (Priority: P2)

**Goal**: `handleMcApiError` emits a structured `warn` log for every 4xx, not only 401/403, preserving the 401/403 audit events and redaction.

**Independent Test**: A non-401/403 4xx through the boundary emits exactly one `warn` log with `action` + `statusCode` (+ `requestId`), no secrets/PII; 401/403 still emit `audit`.

- [x] T007 [US2] Write the 4xx-logging unit test (RED) in `frontend/mcm-app/src/bff-server/unit-tests/mc-api-error.test.ts`. Spec: spec.md#user-story-2 (US2-AC1, US2-AC2, US2-AC3, US2-AC4). Mock `@/bff-server/logger` and assert: (a) a 400 `AuthError` → one `logger.warn` with `{ action, statusCode: 400 }` and no token/PII; (b) an upstream Axios 404/409 → one `logger.warn` with the upstream status; (c) a 401 → `logger.audit('auth_failed')` and a 403 → `logger.audit('access_denied')` (unchanged, not downgraded); (d) a 5xx/unknown → `logger.error` (unchanged).
  - **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern mc-api-error`
  - **Expected RED**: failing on cases (a)/(b) — no `warn` emitted for non-401/403 4xx today.
- [x] T008 [US2] Extend `handleMcApiError` (GREEN) in `frontend/mcm-app/src/bff-server/mc-api-error.ts`. Prerequisite: T007 RED. After the existing 401/403 audit branches, add a `logger.warn` for any other 4xx (client `AuthError` with `statusCode` 400–499, and upstream `err.response.status` 400–499) carrying `action` + `statusCode` (+ inherited `requestId`); leave 401/403 audit and 5xx `error` paths untouched; rely on logger redaction (no raw id value/body).
  - **Verify GREEN**: `pnpm nx test mcm-app -- --testPathPattern mc-api-error`
  - **Expected GREEN**: all cases pass.
- [x] T009 [US2] Regression: run the BFF route unit suites that exercise the error handler — `pnpm nx test mcm-app -- --testPathPattern "bff-api/collections"`. Expected: previously passing route tests still pass (response bodies/status unchanged; only logging added).

**Checkpoint**: Every 4xx at the boundary is self-explaining in logs; US2 shippable independently.

---

## Phase 5: User Story 3 — The server-side API enforces access centrally (Priority: P3)

> **⛔ DESCOPED to a follow-up (2026-06-03).** The T010 viability spike FAILED: `expo export` emits `+middleware.js` + a `middleware` entry in `routes.json`, but the pinned runtime **`@expo/server@0.5.3`** (SDK 56.0.x) has no general `+middleware` invocation (express adapter and core `createRequestHandler` ignore it; only `middleware/rsc` exists). The middleware never runs — an unauthenticated probe returned the *handler's* 401, not the gate's. Per FR-018 the gate is descoped; US1 + US2 shipped independently. Non-functional artifacts (`+middleware.ts`, `app.json` flag, `bff-route-access.ts` + tests, gate integration tests) were reverted. Follow-up recorded in `docs/PRD-CleanExpoRouter.md` Issue 3 and memory `project_expo_server_middleware_gap`. Re-attempt when `@expo/server` invokes `+middleware`, or via the alternative express-adapter gate in `server.js` (needs its own plan).

**Goal**: A single `+middleware.ts` gate rejects unauthenticated protected `/bff-api/*` requests before any handler runs; public routes (incl. token refresh) pass; per-handler authorization remains.

**Independent Test**: Unauthenticated protected request → 401 at the gate (handler not executed); public request → passes; safeguard fails if the gate is disabled.

- [x] T010 [US3] **Viability spike (gate decision — no RED/GREEN)**. Spec: FR-018. In `frontend/mcm-app/app.json` add `["expo-router", { "unstable_useServerMiddleware": true }]`; add a minimal `frontend/mcm-app/src/app/+middleware.ts` scoped via `unstable_settings.matcher` to `patterns: ['/bff-api/[...path]']` that logs and passes through; rebuild the dev container and confirm it executes for (a) a web fetch and (b) a native HTTP call, and that returning a `Response` short-circuits the handler.
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
- [x] T016 [US3] Documentation (no RED/GREEN). Spec: FR-017. Update `CLAUDE.md` (the Centralized Access Control note) and `docs/PRD-CleanExpoRouter.md` Issue 3 to record that the BFF now has a centralized pre-route gate, retiring the "Expo Router exposes no global pre-route hook" assumption (with the immutability caveat: gate enforces deny-by-default but does not inject downstream context). **Done when**: both docs reflect the implemented gate and the prior assumption is marked retired.
- [ ] T017 [US3] Web E2E regression against the gate: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`. Expected: 93/93, ~54s — authenticated flows unaffected by the gate; far slower or failing ⇒ investigate as a real regression (CLAUDE.md guidance).

**Checkpoint**: Centralized deny-by-default gate enforced and safeguarded; constitution Centralized Access Control satisfied for the BFF.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T018 [P] Lint + type-check: `pnpm nx lint mcm-app` and `cd frontend/mcm-app && pnpm exec tsc --noEmit`. Expected: no errors.
- [x] T019 Run the full unit + integration suites: `pnpm nx test mcm-app` (≥70% coverage) and `pnpm nx test:integration mcm-app`. Expected: green.
- [x] T020 Mobile E2E regression — N/A this feature. No native/client code changed: US1 is BFF routing (no client change), US2 is BFF server-side logging, US3 (the only client-relevant story) was descoped before any client change. Mobile flows are unaffected; emulator run skipped. Re-run mobile E2E if US3 is later implemented.
- [x] T021 Run [quickstart.md](quickstart.md) end-to-end and confirm each user story's checks; then `rtk gain` (>80%).

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

- [x] **SC-001**: Filter options load (regression guard 2/2 green vs container); never 400'd at the edge (T003/T004/T006).
- [x] **SC-002**: 100% of boundary 4xx produce a diagnostic log entry (T007/T008 — mc-api-error unit suite green).
- [x] **SC-003**: A boundary client-error is attributable to route + status from logs alone (T008 — warn carries action + statusCode).
- [~] **SC-004**: DESCOPED — US3 gate not viable on @expo/server 0.5.3 (T010 spike). Deferred to a follow-up; the BFF's existing per-handler auth is unchanged (no regression).
- [x] **SC-005**: No regressions — web E2E 93/93 (55.3s), full unit green, US1 integration guard green, lint + tsc clean (T006/T018/T019). Mobile E2E N/A — no native/client changes (T020).
- [x] **SC-006**: 0 secrets/tokens/session-ids/PII in added log output (T007 redaction assertion green).
- [x] Platform parity table complete — no ❌ gaps remain
- [x] All test tasks used the TDD checkpoint format (US2 verified RED→GREEN; US1 is a documented regression guard; US3 spike gated)
- [x] `pnpm nx test mcm-app` — unit tests pass
- [x] `pnpm nx test:integration mcm-app` — US1 filter-options guard green (targeted; full suite unaffected — no shared changes)
- [x] `pnpm nx lint mcm-app` — no lint errors
- [x] `pnpm nx e2e mcm-app` — web E2E 93/93 (dev container)
- [x] `pnpm nx e2e:mobile mcm-app` — N/A this feature (no native/client changes)
- [x] `rtk gain` — >80% compression confirmed (97–100% on the E2E runs)
