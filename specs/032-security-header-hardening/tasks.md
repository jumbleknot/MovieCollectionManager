---
description: "Task list — Security Header Hardening (DAST remediation)"
---

# Tasks: Security Header Hardening (DAST remediation)

**Input**: Design documents from `specs/032-security-header-hardening/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/security-headers-contract.md](./contracts/security-headers-contract.md), [quickstart.md](./quickstart.md)

**Tests**: REQUIRED (constitution §TDD + FR-015). Every code change is preceded by a RED test; verification commands are inline.

**Organization**: Grouped by user story (P1 → P3). Each story is an independently testable increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 (setup/foundational/polish have no story label)
- All paths are relative to repo root.

## Path note

`server.js` is the hand-written **CommonJS** Expo adapter; the new header builder is a sibling plain-JS module (`frontend/mcm-app/web-security-headers.js`) it can `require()` at boot — it CANNOT import the app's compiled TS (research R1/plan Structure Decision).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the environment that makes the CSP correct and the tests deterministic.

- [ ] T001 Confirm the dev-container BFF is passed a **browser-facing** Keycloak origin so the CSP `connect-src` resolves correctly under E2E. Verify `EXPO_PUBLIC_KEYCLOAK_URL` (or `KEYCLOAK_PUBLIC_URL`) is set to `http://localhost:8099` for the `bff-nonsecure` profile in `infrastructure-as-code/docker/stacks/mcm.compose.yaml` (NOT the internal `keycloak-service:8080`, which the browser can't reach). If absent, add it. **Done when**: the profile exposes a browser-reachable Keycloak origin env var consumed by `server.js` at boot (research R3).

**Checkpoint**: Env confirmed — the CSP will carry the correct Keycloak origin in dev/CI.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None. The three stories touch disjoint files (`server.js`+builder / `run+api.ts` / `allowlist.yaml`+Caddy) and are independently implementable and testable. No shared foundational code blocks them.

**Checkpoint**: Proceed directly to user stories (any order; priority order recommended).

---

## Phase 3: User Story 1 — Security headers protect the whole web surface (Priority: P1) 🎯 MVP

**Goal**: Every browser-rendered page and static asset carries the baseline security headers (enforcing CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`), `X-Powered-By` is gone, and the strict API CSP is unchanged — without breaking the web app.

**Independent Test**: `GET /` and a static asset carry the baseline headers and no `X-Powered-By`; `GET /bff-api/auth/init` still returns `Content-Security-Policy: default-src 'none'`; the web app renders and runs with zero browser CSP-console violations.

### Tests for User Story 1 ⚠️ (write FIRST, verify RED)

### T002 [US1] — Write RED unit test for the web security-header builder

**Type**: New file | **Time**: 40 min | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) US1 (FR-001..FR-004, FR-006, FR-007, FR-010)

**Scenarios covered**:
- US1-AC1: HTML shell response includes CSP + anti-clickjacking + nosniff + referrer policy
- US1-AC4: API surface keeps the strict CSP (builder marks `/bff-api` paths CSP-exempt)

**File(s)**: `frontend/mcm-app/web-security-headers.test.js`

Assert the pure builder against [contracts/security-headers-contract.md](./contracts/security-headers-contract.md): `buildWebSecurityHeaders({ keycloakOrigin: 'http://localhost:8099' })` returns the web-app CSP string (with `connect-src 'self' http://localhost:8099`, `frame-ancestors 'none'`, `default-src 'self'`, `object-src 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; a helper `isApiPath('/bff-api/x')` is `true` and `isApiPath('/')` is `false`; a malformed `keycloakOrigin` falls back to the localhost default (never emits a broken directive).

**Verify RED**:
```bash
pnpm nx test mcm-app -- --testPathPattern web-security-headers
```
**Expected RED**: FAIL — `Cannot find module './web-security-headers'` (module not yet created).

### T003 [US1] — Implement the web security-header builder

**Type**: Implementation | **Time**: 1 hr | **Risk**: Low

**Spec reference**: same as T002

**Prerequisite**: T002 complete and verified RED.

Create `frontend/mcm-app/web-security-headers.js` (CommonJS): export `buildWebSecurityHeaders({ keycloakOrigin })` returning the four static header values + the web-app CSP string (directives from research R2; `connect-src 'self' <origin>`), and `isApiPath(pathname)` (`startsWith('/bff-api')`). Reduce `keycloakOrigin` to `new URL(x).origin`; on parse failure fall back to `http://localhost:8099`. JSDoc records the governing requirements (FR-001..FR-004, FR-006, FR-007) — no `FR-###` in identifiers.

**Verify GREEN**:
```bash
pnpm nx test mcm-app -- --testPathPattern web-security-headers
```
**Expected GREEN**: `PASS` — all builder assertions pass.

### T004 [US1] — Write RED Playwright header assertion across surfaces

**Type**: New file | **Time**: 45 min | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) US1 (FR-001..FR-006, FR-010, FR-015)

**Scenarios covered**:
- US1-AC1: HTML shell carries the baseline headers
- US1-AC2: static asset carries `nosniff` (+ baseline)
- US1-AC4: API CSP still strict

**File(s)**: `frontend/mcm-app/tests/e2e/web/security-headers.spec.ts`

Using `page.request`: `GET /` asserts CSP present + web-app value (contains `default-src 'self'` and `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and **no** `x-powered-by`; `GET` a static asset (`/favicon.ico`) asserts `x-content-type-options: nosniff` and no `x-powered-by`; `GET /bff-api/auth/init` asserts exactly `content-security-policy: default-src 'none'`. Opt out of any auth state not needed (public routes). Run against the dev-container BFF for the real `server.js`.

**Verify RED**:
```bash
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/security-headers.spec.ts
```
**Expected RED**: FAIL — `expected 'nosniff' … received undefined` / CSP absent on `/` (middleware not wired yet).

### Implementation for User Story 1

### T005 [US1] — Wire the baseline-header middleware into server.js

**Type**: Implementation | **Time**: 1 hr | **Risk**: Medium (site-wide response change)

**Spec reference**: [spec.md](./spec.md) US1 (FR-001..FR-004, FR-006, FR-007, FR-010, FR-013)

**Prerequisite**: T003 GREEN, T004 verified RED.

Edit `frontend/mcm-app/server.js`: `require('./web-security-headers')`; compute the Keycloak origin once at boot from `process.env` (`EXPO_PUBLIC_KEYCLOAK_URL || KEYCLOAK_PUBLIC_URL || KEYCLOAK_URL || 'http://localhost:8099'`, empty-as-absent) and precompute the header set. Add `app.disable('x-powered-by')`. Add ONE `app.use((req,res,next)=>{…})` **before** `express.static` (alongside the existing `X-BFF-Source` middleware): always set `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`; set the web-app `Content-Security-Policy` ONLY when `!isApiPath(req.path)` (path-scoped so the API keeps its strict handler CSP — research R4). Do not touch auth or any handler (FR-013).

**Verify GREEN**:
```bash
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/security-headers.spec.ts
```
**Expected GREEN**: `passed` — headers present on `/` + static, absent `x-powered-by`, API CSP still `default-src 'none'`.

**Also run the touched suite** (regression check):
```bash
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/auth.spec.ts
```
**Expected**: still passing (login/SSR unaffected).

### T006 [US1] — Validate & finalize the CSP in a real browser (report-only → enforcing)

**Type**: Config change | **Time**: 1.5 hrs | **Risk**: Medium

**Spec reference**: [spec.md](./spec.md) US1 (FR-001, SC-002); clarification 2026-07-09

Run the app (`pnpm start` in `frontend/mcm-app`, web on `:8081`). If unsure of the exact `script-src`/`style-src`/`worker-src` set, temporarily emit `Content-Security-Policy-Report-Only` (dev-only), exercise every screen + login + assistant dock + one agent turn + import/export, and collect console `Refused to …` violations. Add the **minimal** directive to clear each (e.g. `wasm-unsafe-eval`, `blob:`), update `web-security-headers.js` + T002's expected string. **Switch the header name back to the enforcing `Content-Security-Policy`** — report-only MUST NOT ship.

**Done when**: a manual browser load of every flow shows **zero** CSP console violations AND the shipped header is enforcing (`Content-Security-Policy`, not `-Report-Only`). Update the recorded directive set in [contracts/security-headers-contract.md](./contracts/security-headers-contract.md) if it changed.

**Checkpoint**: US1 fully functional — MVP. Baseline headers live on the web surface, app works, API strict CSP intact.

---

## Phase 4: User Story 2 — Cross-origin access to the agent endpoint is restricted (Priority: P2)

**Goal**: `/bff-api/agent/run` returns no `Access-Control-Allow-Origin` header; agent streaming is unchanged.

**Independent Test**: the agent endpoint response has no `access-control-allow-origin` header; the agent conversation/streaming flows pass unchanged.

### T007 [US2] — Runtime-verify the CopilotKit CORS headers on the agent endpoint

**Type**: Utility script | **Time**: 30 min | **Risk**: None

**Spec reference**: [spec.md](./spec.md) US2 (FR-008); research R5

Drive an authenticated request to `/bff-api/agent/run` (via the E2E-authenticated context or a valid session cookie) and record exactly which `Access-Control-*` headers the CopilotKit runtime emits (`*`, reflected Origin, or none). This fixes the exact header name(s) to delete in T009.

**Done when**: the emitted `Access-Control-*` header set on `/bff-api/agent/run` is recorded (in the PR description or a note under research R5).

**⚠️ Hard gate for T008 (resolves analysis finding T1)**: this task MUST complete before T008 is written, because it determines whether a genuine RED is possible:
- **If an `Access-Control-Allow-Origin` header IS emitted** (`*` or a reflected origin) → T008 is a normal RED→GREEN pair (assert absent → RED now, GREEN after T009).
- **If NO ACAO header is emitted** under any request shape → a RED is impossible (a never-RED test is not a TDD test, constitution §TDD). Reclassify T008 as an **idempotent-absence regression guard** (assert the header stays absent) rather than a RED/GREEN pair, and record in the PR that ZAP 10098 was latent/false-positive under the current CopilotKit version. The T009 delete is still correct and idempotent.

### T008 [US2] — Write RED test asserting the agent CORS header is absent

**Type**: New file | **Time**: 40 min | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) US2 (FR-008, FR-009)

**Scenarios covered**:
- US2-AC1: agent endpoint response has no cross-origin allowance header

**File(s)**: `frontend/mcm-app/tests/e2e/web/agent-cors.spec.ts`

With an authenticated session, issue the runtime `GET /bff-api/agent/run` info request (and/or a minimal POST) via `page.request` and assert `response.headers()['access-control-allow-origin']` is `undefined` and `access-control-allow-credentials` is `undefined`. (Inherits the E2E session; reuse the agent-spec auth pattern.)

**Verify RED**:
```bash
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/agent-cors.spec.ts
```
**Expected RED**: FAIL — `expected undefined, received '*'` (or the reflected origin recorded in T007). *If T007 found no ACAO header is emitted, make the RED assert the pre-strip state another way, or record that the finding is latent — the strip in T009 is still correct and idempotent.*

### T009 [US2] — Strip the cross-origin allowance from the agent runtime Response

**Type**: Implementation | **Time**: 45 min | **Risk**: Medium (must not break streaming)

**Spec reference**: [spec.md](./spec.md) US2 (FR-008, FR-009)

**Prerequisite**: T008 in place (verified RED if T007 found an emitted ACAO header; otherwise the absence regression guard from T007's hard gate).

Edit `frontend/mcm-app/src/app/bff-api/agent/run+api.ts`: in `gated()`, replace `return handleRequest(req);` with `const res = await handleRequest(req); res.headers.delete('access-control-allow-origin'); res.headers.delete('access-control-allow-credentials'); return res;`. Do NOT touch the streaming body or any content header (FR-009). JSDoc notes the governing requirement.

**Verify GREEN**:
```bash
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/agent-cors.spec.ts
```
**Expected GREEN**: `passed` — no `access-control-allow-origin` on the agent endpoint.

**Also run the touched suite** (streaming regression — SC-005):
```bash
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/agent-search.spec.ts
```
**Expected**: still passing (agent streaming intact). *(Rebuild the BFF image first if testing the container: `pnpm nx docker-build mcm-app`.)*

**Checkpoint**: US2 complete — agent CORS dropped, streaming unaffected.

---

## Phase 5: User Story 3 — Reduce disclosure and finalize scan posture (Priority: P3)

**Goal**: Server-technology disclosure gone (delivered by US1's `x-powered-by` disable), HSTS verified on the HTTPS edge, and the timestamp false positive allowlisted.

**Independent Test**: no `X-Powered-By` on any response; HSTS present on the prod-secure edge and absent on plain-HTTP dev/CI; the 10096 finding is suppressed from the gate but still in the report.

### T010 [US3] — Allowlist the timestamp-disclosure false positive (ZAP 10096)

**Type**: Config change | **Time**: 20 min | **Risk**: None

**Spec reference**: [spec.md](./spec.md) US3 (FR-012, SC-006); research R7

Append to `security/zap/allowlist.yaml` (replace the empty `[]`): `pluginId: "10096"`, `uriPattern: "http://.*/_expo/static/.*"`, a non-empty `justification` (build-artifact timestamps in the compiled JS bundle, not secrets/clock), `addedBy: "steve"`. Validate the schema (blank justification/addedBy is a gate error).

**Done when**: `node scripts/check-dast-findings.mjs --selftest` passes and the entry parses (10096 excluded from the gate, still present in the report).

### T011 [US3] — Verify HSTS at the HTTPS edge (present) and its absence on plain HTTP

**Type**: Config change | **Time**: 30 min | **Risk**: None

**Spec reference**: [spec.md](./spec.md) US3 (FR-011, SC-007); research R6

Confirm `infrastructure-as-code/docker/bff/Caddyfile` already emits `Strict-Transport-Security: max-age=31536000; includeSubDomains` (line 27) on the prod-secure edge, and that the production reverse proxy in front of `mcm.<domain>` carries the same header (Komodo-managed — verify, do not hand-edit). Confirm the plain-HTTP dev/CI BFF (`:8082`) emits none.

**Done when**: HSTS present on `https://localhost:8443/` (feature-007 secure container) and on the prod edge; absent on `http://localhost:8082/`. Commands: quickstart §7.

### T012 [US3] — Re-run the DAST baseline and confirm remediation

**Type**: Utility script | **Time**: 30 min | **Risk**: None

**Spec reference**: [spec.md](./spec.md) US3 (FR-014, SC-001, SC-006)

**Prerequisite**: US1 (T005/T006) and US2 (T009) merged into the running dev-container BFF; rebuild the image first (`pnpm nx docker-build mcm-app`) so the scan hits the new code, not a stale image.

Run `pnpm nx dast infrastructure-as-code` (baseline). Confirm the gate result no longer reports ZAP 10038, 10020, 10021, 10037, 10098 on the BFF surface, and 10096 is allowlisted (still visible in `security/zap/report.json`).

**Done when**: the DAST baseline gate passes with the five findings gone and 10096 suppressed-but-listed (contracts §Gate contract).

**Checkpoint**: US3 complete — disclosure closed, HSTS verified, scan posture finalized.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T013 [P] Update docs: note the web-surface security headers + agent CORS strip in `security/zap/README.md` (or [docs/runbooks/dast-scanning.md](../../docs/runbooks/dast-scanning.md)); record the final CSP directive set if it changed from research R2.
- [ ] T014 Full regression + final validation: `pnpm nx e2e mcm-app` (web, SC-002/SC-003), `pnpm nx test mcm-app` (unit), CI runs the mobile agent E2E (SC-008 — Metro OOMs locally after ~1–2 `/run` calls), then `rtk gain` (>80%, run last).

---

## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1/AC2: baseline security headers on HTML + static | `security-headers.spec.ts` | N/A — CSP/security response headers are a browser concern; React Native does not apply web CSP (spec Edge Cases: "Native mobile client") | N/A |
| US1-AC4: API strict CSP preserved | `security-headers.spec.ts` | N/A — server-response header assertion, not a UI flow | N/A |
| US2-AC1: agent endpoint has no cross-origin allowance | `agent-cors.spec.ts` | N/A — response-header assertion on a same-origin endpoint; no client-visible UI difference | N/A |
| US2-AC2: agent streaming intact after CORS change | `agent-search.spec.ts` | `agent-search.yaml` | ✅ |
| US3-AC1: no server-technology disclosure header | `security-headers.spec.ts` | N/A — response-header assertion, not a UI flow | N/A |
| US3-AC2: HSTS present on HTTPS edge / absent on HTTP | quickstart §7 (curl/verify) | N/A — edge/infra verification, not a UI flow | N/A |
| US3-AC3: 10096 suppressed from gate, visible in report | `scripts/check-dast-findings.mjs` (gate) | N/A — scan-tooling task, not a UI flow | N/A |

All mobile `N/A` cells are justified (web/infra/tooling concerns with no native UI surface); the one client-visible behavior (agent streaming) is covered on both platforms.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately.
- **Foundational (Phase 2)**: empty — no blocker.
- **User Stories (Phase 3–5)**: each depends only on Setup. They touch disjoint files and can proceed in parallel or in priority order (P1 → P2 → P3).
- **Polish (Phase 6)**: after the stories being shipped are complete. T012 (DAST re-run) needs US1 + US2 merged into the running image.

### Within each story

- Test (RED) before implementation (GREEN). US1: T002→T003→T004→T005→T006. US2: T007→T008→T009. US3: T010/T011/T012 (config/verify, no RED/GREEN except gate self-test).

### Parallel Opportunities

- US1, US2, US3 are file-disjoint — different developers can take one each after Setup.
- Within US3, T010 / T011 are independent ([P]).
- T013 ([P]) is independent of code once US1/US2 land.

---

## Parallel Example

```bash
# After Setup (T001), three developers in parallel:
#  Dev A → US1 (server.js + web-security-headers.js + tests)
#  Dev B → US2 (run+api.ts CORS strip + test)
#  Dev C → US3 (allowlist.yaml + HSTS verify)
# US3's DAST re-run (T012) waits for A + B to merge.
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup (T001).
2. Phase 3 US1 (T002–T006) — RED→GREEN, then browser-validate the enforcing CSP.
3. **STOP and VALIDATE**: baseline headers live, web app works, API CSP intact. This alone closes F1/F2/F3/F4.

### Incremental Delivery

1. Setup → US1 (MVP, headers) → US2 (agent CORS) → US3 (allowlist + HSTS verify + DAST re-run).
2. Each story ships independently; the DAST re-run at the end proves the full remediation.

---

## Completion Checklist

Before marking `032-security-header-hardening` complete, verify all success criteria from [spec.md](./spec.md):

- [ ] **SC-001**: DAST baseline re-run reports zero occurrences of the five remediated findings on the BFF surface
- [ ] **SC-002**: 100% of web E2E pass with the enforcing CSP + zero manual browser CSP-console violations
- [ ] **SC-003**: every HTML + static-asset response carries the applicable baseline headers
- [ ] **SC-004**: API surface retains `Content-Security-Policy: default-src 'none'` (0 loosened)
- [ ] **SC-005**: agent flows pass unchanged; agent endpoint returns no cross-origin allowance header
- [ ] **SC-006**: 10096 absent from the gate result, present in the scan report
- [ ] **SC-007**: HSTS present on the HTTPS edge, absent on plain-HTTP dev/CI
- [ ] **SC-008**: mobile E2E unaffected (0 regressions)
- [ ] Platform parity table complete — no ❌ gaps remain
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `pnpm nx test mcm-app` — unit tests pass (≥70% line coverage)
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `pnpm nx e2e mcm-app` — web E2E passes
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes (logged-out start between runs)
- [ ] `rtk gain` — >80% token compression confirmed (run last)

---

## Notes

- [P] = different files, no dependencies.
- `server.js` + `web-security-headers.js` is the injection point (proven to reach static + SSR + API via the existing `X-BFF-Source` marker); `+middleware.ts` is NOT viable (adapter ignores it — memory `project_expo_server_middleware_gap`).
- The web CSP is **path-scoped out of `/bff-api`** so the API strict CSP stays authoritative deterministically (no reliance on adapter same-name merge order).
- HSTS is edge-owned (Caddy) and already present — US3 verifies, never sets it in `server.js`.
- Rebuild the BFF image before any container-based E2E or DAST run, or you validate stale code (feature 011 lesson).
