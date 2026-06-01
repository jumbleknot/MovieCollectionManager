---
description: "Task list for E2E Against the BFF Docker Container"
---

# Tasks: E2E Tests Against the BFF Docker Container

**Input**: Design documents from `specs/007-e2e-bff-container/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [quickstart.md](./quickstart.md)

**Tests**: The "tests" are the existing web + mobile E2E suites run against the container, plus a new prod-lifecycle web test. TDD checkpoints (Verify RED → implement → Verify GREEN) are embedded on verification-bearing tasks; config/doc tasks use the no-RED/GREEN format.

**Organization**: Grouped by user story (P1→P3). Relies on the feature-006 issuer fix already on `main`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no incomplete-task deps)
- **[Story]**: US1–US4 maps to the spec's user stories
- Exact paths included per task

## Path Conventions

BFF compose under `infrastructure-as-code/docker/bff/`; the Expo app under `frontend/mcm-app/`. All build/test ops via Nx (`pnpm nx …`). Container build = `pnpm nx docker-build mcm-app`.

---

## Phase 1: Setup & Baseline

- [ ] T001 Confirm RTK active; bring the full backend stack up (`pnpm nx up-all infrastructure-as-code` — Keycloak+Postgres, MongoDB, mc-service, Redis); build the BFF image (`pnpm nx docker-build mcm-app`).
- [ ] T002 [P] Capture the Metro baseline: record that web + mobile E2E are green on Metro today (the starting reference), so container runs are compared against a known-good state.

**Checkpoint**: image built, stack up, baseline recorded.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: shared mechanisms both US1 and US3 depend on. Complete before the story phases.

- [X] T003 Add a `X-BFF-Source: ${process.env.BFF_SOURCE ?? 'unknown'}` response header to `frontend/mcm-app/server.js` (set on all responses). Metro (`expo start`) never sets it — this is the positive request-path signal (FR-002).
- [X] T004 Add an `E2E_BFF_TARGET` switch to `frontend/mcm-app/playwright.config.ts`: when `dev-container`/`prod-container`, set `baseURL` to the container/proxy URL, **disable** the `webServer` auto-start (do not spawn Metro), and set `ignoreHTTPSErrors: true` for `prod-container`. Unset → today's Metro behavior (FR-004 keeps iterative dev on Metro). Shared `tests/e2e/web/setup/target.ts` mirrors it so specs that build absolute `${BASE}` URLs follow the same target.
- [X] T005 In `frontend/mcm-app/tests/e2e/web/setup/global-setup.ts`, assert the `X-BFF-Source` header on a `/bff-api/*` response (fail fast if it's missing/Metro) before trusting the run; keep session reuse + route warm-up.

**Checkpoint**: marker + target switch in place; web E2E can be pointed at any BFF and will refuse a Metro false-green.

---

## Phase 3: User Story 1 - E2E green against the Dev BFF container (Priority: P1) 🎯 MVP

**Goal**: web + mobile E2E pass against the Dev BFF container (HTTP, non-Secure cookies), with the request path proven to be the container.

**Independent Test**: deploy the dev container, run both suites, confirm green + `X-BFF-Source: dev-container`.

- [X] T006 [US1] Add a **dev-config** BFF service to `infrastructure-as-code/docker/bff/compose.yaml` (`mcm-bff:latest`, `NODE_ENV=development`, `BFF_SOURCE=dev-container`, host port `:8082`, reuse running `mcm-redis` + networks) behind a `bff-dev` profile; wire the profile into the root `compose.yaml` `include:`.
  - **Verify**: `docker compose --profile bff-dev up -d` → container healthy; `curl http://localhost:8082/bff-api/auth/init` returns 200 with header `X-BFF-Source: dev-container`. ✅ `mcm-mcm-bff-dev-1` healthy on `:8082`.
  - **Also required (discovered during T007)**: the `movie-collection-manager` Keycloak client only allowed `:8081` redirect URIs → container login (`:8082`) was rejected. Added `http://localhost:8082/*` + `https://localhost:8443/*` redirect URIs + web origins to the client (running realm; reproducible via `infrastructure-as-code/docker/keycloak/scripts/add-container-redirect-uris.mjs`).
- [X] T007 [US1] Spike — deploy the dev container, stop Metro, run `global-setup` login against it; confirm a session is established over HTTP.
  - **Verify RED→GREEN**: login succeeds against the dev container; `/bff-api/collections` returns 200. ✅
  - **ROOT CAUSE found here (was R6/T012 territory)**: the feature-006 `Premature close` lines are **symptom noise** (Playwright aborting in-flight requests on failing tests), NOT a login-streaming blocker — login works. The real blocker was **container token refresh**: the browser logs in at `localhost:8099` so tokens carry `iss=localhost:8099`, but the container BFF runs the `refresh_token` grant over `keycloak-service:8080`; Keycloak (dynamic hostname) rejected the issuer → **`400 invalid_grant: Invalid token issuer`**. Login survived because the `authorization_code` grant doesn't validate a pre-issued issuer — only `refresh_token` does. Over a run, access-cookie expiry (5 min) → refresh fails → `no_token` cascade → 60s `gotoHome` timeouts (the 23-min run). **FIX**: pin a stable issuer in `infrastructure-as-code/docker/keycloak/compose.yaml` — `KC_HOSTNAME=http://localhost:8099` + `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` (issuer fixed; token/JWKS endpoints stay per-request-host so the container still reaches `keycloak-service:8080`). `/bff-api/auth/refresh` → 200 (was 400). This also resolves the R6/T012 refresh leg at the Keycloak layer (carries to prod).
- [X] T008 [US1] Run the **web** E2E suite against the dev container: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` (Metro stopped).
  - **Verify GREEN**: full web suite passes; `X-BFF-Source: dev-container` confirmed. ✅ **92/92 passed, 0 failed, 0 flaky, ~50s** (JSON-reporter authoritative). No Metro-JIT timeouts — the container serves a prebuilt bundle, so the run is *faster* than Metro (50s vs ~2.5 min).
- [ ] T009 [US1] Mobile dual-port: extend `frontend/mcm-app/scripts/maestro-e2e.mjs` (or its env setup) so Metro serves JS on `:8081` while the app's `/bff-api` calls target the dev container on `:8082` — start Metro with `EXPO_PUBLIC_BFF_NATIVE_URL=http://localhost:8082`, `adb reverse tcp:8082 tcp:8082` (plus the existing `:8081`).
  - **Verify GREEN**: `pnpm nx e2e:mobile mcm-app` → all flows pass; the dev container's logs show the app's `/bff-api` hits (`X-BFF-Source: dev-container`), proving BFF-in-container (not a Metro-served BFF).

**Checkpoint**: dev-container web + mobile E2E green, request path proven (SC-001).

---

## Phase 4: User Story 2 - Final E2E uses the container; other tests stay on Metro (Priority: P2)

**Goal**: documented, reproducible local instructions scoping the container to the final E2E run.

**Independent Test**: a new operator follows the instructions and reproduces a green containerized final E2E with no undocumented steps.

- [ ] T010 [US2] Update `CLAUDE.md` testing instructions: build/deploy the BFF container before the **final local** E2E run (`bff-dev` for the standard final run), with the `E2E_BFF_TARGET` web command and the mobile dual-port setup; state that unit/integration/iterative E2E stay on Metro and that CI is unchanged (no CI E2E job). Reference [quickstart.md](./quickstart.md).
  - **Done when**: the instructions are sufficient for a fresh operator to reproduce T008/T009 with zero undocumented steps (FR-004, SC-002/SC-003).

**Checkpoint**: instructions reproducible.

---

## Phase 5: User Story 3 - E2E green against the Prod BFF container (Priority: P2)

**Goal**: web + mobile E2E pass against the production-hardened container over HTTPS, including the full auth lifecycle, with hardening confirmed intact.

**Independent Test**: deploy prod container behind TLS, run both suites green incl. login→expiry-refresh→logout, security review passes, request path proven prod-container.

- [ ] T011 [US3] Add the **prod** path to `infrastructure-as-code/docker/bff/compose.yaml`: `mcm-bff` with `NODE_ENV=production` (Secure cookies) + a `caddy` TLS-terminating proxy on `https://localhost:8443` (`BFF_SOURCE=prod-container`), with a `Caddyfile` + local/self-signed CA generation; behind a `bff-prod` profile wired into the root compose. **Configure the TLS front for TLS 1.3 + HSTS, and confirm the BFF's existing CORS allowlist + security headers (CSP/X-Frame-Options/X-Content-Type-Options/Referrer-Policy) pass through the proxy unchanged.**
  - **Verify**: `docker compose --profile bff-prod up -d` → `curl -k https://localhost:8443/bff-api/auth/init` → 200 + `X-BFF-Source: prod-container`; response carries HSTS + the security headers; negotiated TLS is 1.3.
- [ ] T012 [US3] Spike + reconcile (R6) against the prod container over HTTPS: in order, (1) login completes + session persists, (2) access-token expiry → transparent refresh, (3) logout terminates BFF + Keycloak SSO session. Apply only the minimal `frontend/mcm-app/src/bff-server/*` fixes proven necessary; keep `Secure` cookies (FR-007 — do not disable for tests).
  - **Verify RED→GREEN**: reproduce each failure against the prod container first, then confirm fixed; capture the exact symptom + minimal change for each.
- [ ] T013 [US3] Write a prod-lifecycle web test `frontend/mcm-app/tests/e2e/web/bff-prod-lifecycle.spec.ts`: login → advance Playwright fake clock past the access-token TTL → assert a protected request transparently refreshes → logout → assert the session (and SSO) is terminated.
  - **Verify RED**: `E2E_BFF_TARGET=prod-container pnpm nx e2e mcm-app -- bff-prod-lifecycle.spec.ts` fails before T012's fixes.
- [ ] T014 [US3] Run the **web** E2E suite (incl. T013) against the prod container: `E2E_BFF_TARGET=prod-container pnpm nx e2e mcm-app`.
  - **Verify GREEN**: full web suite + lifecycle test pass over HTTPS; `Secure` cookies sent (not disabled); `X-BFF-Source: prod-container`.
- [ ] T015 [US3] Mobile against the prod container (HTTPS): install/trust the local CA on the emulator — **prefer a debug `network_security_config.xml` trusting the bundled test CA (deterministic across emulator restarts) over a runtime `adb` CA push** (see research R3); start Metro with `EXPO_PUBLIC_BFF_NATIVE_URL=https://localhost:8443`, `adb reverse tcp:8443 tcp:8443`; run `pnpm nx e2e:mobile mcm-app`.
  - **Verify GREEN**: all flows pass against the HTTPS prod container; prod container logs show the app's hits. **If neither CA-trust mechanism is reliable → escalate and document prod-mobile as CA-trust-limited while prod-web passes** (research R3).
- [ ] T016 [US3] Security review of the prod-reconciliation changes (FR-008): run the project security review over the branch; resolve all High/Critical; confirm `Secure`-cookie / TLS / token-validation hardening is **intact, not disabled for tests**; triage + document Medium/Low. **Explicitly verify the constitution's Transport Security set on the prod-container path — TLS 1.3, HSTS, CORS allowlist, and the security headers (CSP/X-Frame-Options/X-Content-Type-Options/Referrer-Policy) — are present and not relaxed for tests.**
  - **Done when**: 0 unresolved High/Critical; full transport-hardening set confirmed intact (SC-005).

**Checkpoint**: prod-container web + mobile E2E green over HTTPS; lifecycle proven; security review clean (SC-004/SC-005).

---

## Phase 6: User Story 4 - Return to local dev + cleanup (Priority: P3)

**Goal**: back to Metro-based dev; only BFF/proxy containers removed.

**Independent Test**: run teardown; confirm no orphaned BFF/proxy containers, persistent stack intact, Metro dev works.

- [ ] T017 [US4] Tear down: `docker compose --profile bff-dev down` + `docker compose --profile bff-prod down` (removes only the BFF + Caddy containers; reuses/keeps the persistent external volumes + shared stack); unset `EXPO_PUBLIC_BFF_NATIVE_URL`; restart Metro from `frontend/mcm-app`.
  - **Done when**: `docker compose ps` shows no `mcm-bff`/`caddy` containers; the persistent stack (Keycloak/Mongo/Redis/mc-service) is still up; normal Metro dev runs (SC-007).

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T018 [P] Regression (FR-011/SC-006): `pnpm nx test mcm-app` + `pnpm nx test:integration mcm-app` + `pnpm nx test mc-service` + `pnpm nx test:integration mc-service` — all green; zero end-user behavior change.
- [ ] T019 [P] Doc sweep: confirm `CLAUDE.md` + `quickstart.md` document the dev/prod container E2E, the marker, the mobile dual-port, the prod HTTPS/CA step, and cleanup; no stale instructions (FR-004, SC-002).
- [ ] T020 Run the [quickstart.md](./quickstart.md) Definition-of-Done checklist end-to-end.
- [ ] T021 `rtk gain` → confirm >80% per-test-run compression (constitution; run last).

---

## Platform Parity Table

US1 and US3 run E2E on both clients; US2/US4 are not UI flows.

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1: E2E green vs Dev container | `E2E_BFF_TARGET=dev-container` over all `tests/e2e/web/*.spec.ts` | all `tests/e2e/mobile/*.yaml` (Metro :8081 + container :8082) | ✅ |
| US3: E2E green vs Prod container (HTTPS) | `E2E_BFF_TARGET=prod-container` over all web specs + `bff-prod-lifecycle.spec.ts` | all mobile flows (HTTPS + emulator CA trust) | ✅ |
| US2: test-instruction update | N/A — documentation task, not a UI flow | N/A — documentation task, not a UI flow | N/A |
| US4: return to dev + cleanup | N/A — teardown/process task, not a UI flow | N/A — teardown/process task, not a UI flow | N/A |

No `❌ Gap` rows.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (P1)** → **Foundational (P2)** blocks the story phases.
- **US1 (P3)** depends on P2; is the MVP.
- **US2 (P4)** depends on US1 (documents the US1 run).
- **US3 (P5)** depends on P2 + the US1 dev path proven; carries the prod reconciliation + security review.
- **US4 (P6)** after the validation work.
- **Polish (P7)** last.

### Within stories

- US1: T006 (compose) → T007 (login spike) → T008 (web) ; T009 (mobile) after T006.
- US3: T011 (TLS compose) → T012 (reconcile) → T013 (lifecycle test RED) → T014 (web GREEN) ; T015 (mobile) after T011+T012 ; T016 (security review) after the code is final.

### Parallel Opportunities

- T002 `[P]` (read-only baseline). T018/T019 `[P]` in Polish.
- Foundational T003/T004/T005 touch different files but T005 depends on T003 (the marker) → T003 before T005; T004 independent.
- US1 web (T008) and the US1 mobile wiring (T009) are largely independent once T006 is up.

---

## Implementation Strategy

### MVP First (US1)

1. Setup + Foundational (marker + target switch).
2. US1: dev container → web + mobile E2E green. **STOP & VALIDATE** (this alone proves "BFF works in a container").

### Incremental Delivery

US1 (dev container, MVP) → US2 (instructions) → US3 (prod container + reconciliation + security review) → US4 (cleanup). Each ships independently.

---

## Completion Checklist

Before marking `007-e2e-bff-container` complete, verify all success criteria from [spec.md](./spec.md):

- [ ] **SC-001**: Dev container — web + mobile E2E 100% green; `X-BFF-Source: dev-container` recorded
- [ ] **SC-002**: A new operator reproduces the containerized final E2E from the instructions, zero undocumented steps
- [ ] **SC-003**: Instructions scope the container to the final E2E; Metro for all other phases
- [ ] **SC-004**: Prod container — web + mobile E2E 100% green incl. login→expiry-refresh→logout, over HTTPS
- [ ] **SC-005**: Security review — 0 unresolved High/Critical; Secure/TLS/token-validation hardening intact (not disabled for tests)
- [ ] **SC-006**: Zero end-user behavior change; pre-existing unit/integration/mc-service suites green
- [ ] **SC-007**: Cleanup — no orphaned BFF/proxy containers; persistent stack intact; Metro dev unchanged
- [ ] Platform parity table complete — no ❌ gaps
- [ ] All verification tasks used the TDD checkpoint format (RED before GREEN)
- [ ] `pnpm nx test mcm-app` / `test:integration` / `lint` green
- [ ] `pnpm nx e2e mcm-app` (container) + `pnpm nx e2e:mobile mcm-app` (container) green
- [ ] `rtk gain` — >80% per-test-run
