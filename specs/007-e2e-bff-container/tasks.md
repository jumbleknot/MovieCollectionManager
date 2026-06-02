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
- [X] T009 [US1] Mobile dual-port: Metro serves JS on `:8081` while the app's `/bff-api` calls target the dev container on `:8082`. No `maestro-e2e.mjs` code change was needed — the existing runner works once the env + tunnels are set (the "or its env setup" path).
  - **Reproducible procedure** (dev container up on `:8082`, emulator booted):
    1. `adb reverse tcp:8081 tcp:8081` (Metro JS) **+ `tcp:8082`** (container BFF) **+ `tcp:8099`** (Keycloak — REQUIRED so the emulator reaches the same `localhost:8099` Keycloak the issuer is pinned to).
    2. In `frontend/mcm-app/.env.local` set `EXPO_PUBLIC_BFF_NATIVE_URL=http://localhost:8082` and `EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=http://localhost:8099` (revert to `10.0.2.2` after). **Inline `EXPO_PUBLIC_* = ... expo start` env did NOT reach the bundle — set them in `.env.local`.** Restart Metro `--reset-cache` (these are inlined into the JS bundle).
    3. `pnpm nx e2e:mobile mcm-app`.
  - **Why native Keycloak must be `localhost:8099` (not `10.0.2.2:8099`)**: feature-007 pinned `KC_HOSTNAME=http://localhost:8099`, so tokens/discovery carry `iss=localhost:8099`. `config/keycloak.ts` derives `KEYCLOAK_ISSUER` from `EXPO_PUBLIC_KEYCLOAK_NATIVE_URL`; expo-auth-session rejects an issuer mismatch, so native must use `localhost:8099` (tunneled). The harmless `fetch('/bff-api/auth/init')` in `_layout.tsx` is a *relative* fire-and-forget warm-up that hits the Metro origin — it is NOT the auth path (which goes through `apiClient` → `BFF_BASE_URL` → `:8082`).
  - **Verify GREEN**: ✅ **20/20 Maestro flows passed** (~38 min; one `collection-create` flake recovered on the bounded retry). The dev container logged `audit:login` + `mc_service_request` from the app, proving BFF-in-container (not a Metro-served BFF). Covers registration, login (all variants), logout, collections CRUD, movies CRUD, search/filter.

**Checkpoint**: dev-container web + mobile E2E green, request path proven (SC-001).

---

## Phase 4: User Story 2 - Final E2E uses the container; other tests stay on Metro (Priority: P2)

**Goal**: documented, reproducible local instructions scoping the container to the final E2E run.

**Independent Test**: a new operator follows the instructions and reproduces a green containerized final E2E with no undocumented steps.

- [X] T010 [US2] Update `CLAUDE.md` testing instructions: build/deploy the BFF container before the **final local** E2E run (`bff-dev` for the standard final run), with the `E2E_BFF_TARGET` web command and the mobile dual-port setup; state that unit/integration/iterative E2E stay on Metro and that CI is unchanged (no CI E2E job). Reference [quickstart.md](./quickstart.md).
  - **Done**: added a "Final local E2E runs against the BFF container (feature 007)" section to `CLAUDE.md` (after Test Run Protocol) — Metro for iteration/unit/integration, container for the final run, CI unchanged; includes the issuer-pin prerequisite, the `E2E_BFF_TARGET=dev-container` web command, and the mobile tri-port (`8081/8082/8099`) + `.env.local` dual-port setup. Also corrected `quickstart.md` to match the verified procedure: the issuer-pin prerequisite, `adb reverse tcp:8099`, native Keycloak `localhost:8099`, and that `EXPO_PUBLIC_*` must be set in `.env.local` (inline `$env:` does NOT reach the bundle) with `--reset-cache`.
  - **Done when**: the instructions are sufficient for a fresh operator to reproduce T008/T009 with zero undocumented steps (FR-004, SC-002/SC-003). ✅

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
- [X] T014 [US3] Run the **web** E2E suite (incl. T013) against the prod container: `E2E_BFF_TARGET=prod-container pnpm nx e2e mcm-app`.
  - **Verify GREEN**: ✅ **93/93 passed, 0 failed, 0 flaky, ~70s** over HTTPS — confirmed across 2 consecutive prod runs (and dev: 93/93, 0 flaky, 53s). `Secure` cookies sent (not disabled); `X-BFF-Source: prod-container`. The lifecycle test (T013) is the +1.
  - **Root-caused + fixed a real `home-screen-create-button` race (not luck)**: `gotoHome` waited on `home-route` — the SafeAreaView wrapper that renders **immediately** (with the loading spinner) *before* the FR-009 effect decides. If a prior test left a default collection set, FR-009 called `router.replace()` to that collection *after* `gotoHome` had already returned on `home-route`, stranding the test off `/home` (the create button never appeared → 60s timeout). Those 60s flake-timeouts were also what ballooned long runs past the 5-min access-token TTL → the earlier cascade. **Fix**: all three spec `gotoHome` helpers (collections/movies/bff-prod-lifecycle) now wait on `home-screen-create-button` — the FR-009-*resolved* signal (renders only after `isFr009Checked && !isLoading`) — so a default deterministically resolves to the collection screen and is recovered. Eliminated the flake → suites are now deterministic AND fast (well under the TTL).
- [~] T015 [US3] Mobile against the prod container (HTTPS) — **ESCALATED: CA-trust-limited (research R3's documented fallback).**
  - **Decision + rationale**: prod-mobile over HTTPS requires the emulator/app to trust Caddy's internal CA. The installed debug APK sets `usesCleartextTraffic="true"` (so dev-container HTTP on :8082 works — that's why US1 mobile is green) but has **no** `network_security_config` trusting user-added CAs, and Android API 24+ apps reject user CAs by default. Enabling it needs a debug `network_security_config.xml` (trust-anchors: user) **plus an APK rebuild** (the Windows `CMAKE_OBJECT_PATH_MAX` short-path recipe or the ~20-min CI `android-apk` workflow), then a CA install + a ~38-min Maestro run. Per **research R3**, when CA-trust is not readily achievable this is escalated and documented while prod-web passes.
  - **Why the residual risk is low**: the app and the prod BFF are each independently proven. US1 mobile is GREEN against the dev container (20/20 — proves the app's dual-port wiring + the Keycloak issuer fix in-container), and US3 prod-web is GREEN over HTTPS (93/93 — proves the prod container's TLS 1.3 / HSTS / Secure-cookie / transparent-refresh / logout lifecycle). The only unexercised delta is the **emulator trusting the TLS CA** — a device-config concern, not an app or BFF defect. No prod-mobile-specific code path is left unproven.
  - **To complete later (recipe)**: add `frontend/mcm-app/android/app/src/debug/res/xml/network_security_config.xml` with `<trust-anchors><certificates src="user"/><certificates src="system"/></trust-anchors>` + reference it from the debug `AndroidManifest.xml` (`android:networkSecurityConfig`), rebuild the debug APK, `adb push` + install Caddy's CA (`/data/caddy/pki/authorities/local/root.crt` from the `caddy-data` volume) as a user cert, then run `EXPO_PUBLIC_BFF_NATIVE_URL=https://localhost:8443` + `adb reverse tcp:8443/tcp:8099` + `pnpm nx e2e:mobile mcm-app`.
- [X] T016 [US3] Security review of the prod-reconciliation changes (FR-008): run the project security review over the branch; resolve all High/Critical; confirm `Secure`-cookie / TLS / token-validation hardening is **intact, not disabled for tests**; triage + document Medium/Low. **Explicitly verify the constitution's Transport Security set on the prod-container path — TLS 1.3, HSTS, CORS allowlist, and the security headers (CSP/X-Frame-Options/X-Content-Type-Options/Referrer-Policy) — are present and not relaxed for tests.**
  - **Done**: ✅ project security review run over the branch — **0 High / 0 Critical** (0 findings ≥8 confidence). The two security-sensitive changes are net improvements: the `KC_HOSTNAME` issuer pin **removes** the dynamic-issuer (Host-controlled `iss`) footgun, and the logout `Set-Cookie` fix correctly evicts all three auth cookies. `add-container-redirect-uris.mjs` adds only exact localhost redirect URIs/web origins (no wildcards → no open-redirect, no CORS weakening). Transport-Security set verified on the prod path: **TLS 1.3 enforced (1.2 rejected), HSTS present, CSP/X-Frame-Options/X-Content-Type-Options/Referrer-Policy pass through, CORS allowlist exact, Secure/HttpOnly/SameSite=Strict cookies NOT relaxed for tests** (asserted by `bff-prod-lifecycle.spec.ts`).
  - **Done when**: 0 unresolved High/Critical; full transport-hardening set confirmed intact (SC-005). ✅

**Checkpoint**: prod-container web + mobile E2E green over HTTPS; lifecycle proven; security review clean (SC-004/SC-005).

---

## Phase 6: User Story 4 - Return to local dev + cleanup (Priority: P3)

**Goal**: back to Metro-based dev; only BFF/proxy containers removed.

**Independent Test**: run teardown; confirm no orphaned BFF/proxy containers, persistent stack intact, Metro dev works.

- [X] T017 [US4] Tear down the BFF + Caddy containers; keep the persistent external volumes + shared stack. **Correction:** use `docker compose rm -sf mcm-bff mcm-bff-dev caddy` — **not** `docker compose --profile … down`, which operates on the whole project and would also stop the no-profile shared services (`mc-db`/`mcm-redis`/`rs-init`). The `.env.local` native URLs were already reverted to `10.0.2.2` after T009.
  - **Done**: ✅ removed `mcm-bff` / `mcm-bff-dev` / `caddy`; `docker compose ps` confirms the shared stack (`mc-db`, `mc-service`, `mcm-keycloak-*`, `mcm-redis`) is still Up → normal Metro dev runs (SC-007). quickstart §3 corrected to the targeted `rm -sf`.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T018 [P] Regression (FR-011/SC-006): all green; zero end-user behavior change. ✅ **mcm-app unit 804/804**, **mc-service 99 unit + ~118 integration** (0 failed; ignored ones documented), **BFF integration 45/45** (vs the dev container via `BFF_BASE_URL=http://localhost:8082`). The `KC_HOSTNAME` issuer pin did not regress mc-service token validation; the logout cookie fix is validated at unit + integration (`auth-logout` cookie-clearing assertion) + E2E (`bff-prod-lifecycle`). (Fixed a self-inflicted test bug: the new logout assertion used Playwright's 2-arg `expect(value, msg)` in a Jest test — dropped the message arg.)
- [X] T019 [P] Doc sweep: ✅ `CLAUDE.md` (the "Final local E2E runs against the BFF container" section) + `quickstart.md` document the dev/prod container E2E, the `X-BFF-Source` marker, the mobile dual-port (tri-port + `.env.local`), the issuer-pin prerequisite, the prod HTTPS path, the CA-trust-limited mobile note, and cleanup. Corrected stale bits: the lifecycle test uses cookie-deletion (not a fake clock), and `EXPO_PUBLIC_*` must live in `.env.local`.
- [X] T020 Definition-of-Done checklist (quickstart.md): ✅ Dev container web+mobile green + marker (SC-001); test instructions updated (SC-002/003); prod container web green over HTTPS incl. lifecycle (SC-004) — prod-mobile escalated CA-trust-limited (R3); security review 0 High/Crit + hardening intact (SC-005); zero behavior change, all regression suites green (SC-006); cleanup — no orphaned BFF/proxy containers, shared stack up (SC-007); rtk per-test compression >80%. Only open item is the documented prod-mobile CA-trust escalation.
- [X] T021 `rtk gain` → ✅ per-test-run compression **95–100%** for the playwright/gradle test commands (>80%). The 59.5% *global* figure includes non-test commands (`rtk read` 17%, `ls` 63%) and is not the per-test-run metric.

---

## Platform Parity Table

US1 and US3 run E2E on both clients; US2/US4 are not UI flows.

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1: E2E green vs Dev container | `E2E_BFF_TARGET=dev-container` over all `tests/e2e/web/*.spec.ts` — ✅ 93/93 | all `tests/e2e/mobile/*.yaml` (Metro :8081 + container :8082) — ✅ 20/20 | ✅ |
| US3: E2E green vs Prod container (HTTPS) | `E2E_BFF_TARGET=prod-container` over all web specs + `bff-prod-lifecycle.spec.ts` — ✅ 93/93 | ⚠️ **CA-trust-limited (R3)** — needs a debug `network_security_config` + APK rebuild to trust Caddy's internal CA; deferred (app proven via US1 mobile, BFF proven via US3 web) | ⚠️ web ✅ / mobile escalated |
| US2: test-instruction update | N/A — documentation task, not a UI flow | N/A — documentation task, not a UI flow | N/A |
| US4: return to dev + cleanup | N/A — teardown/process task, not a UI flow | N/A — teardown/process task, not a UI flow | N/A |

No `❌ Gap` rows. One `⚠️` row: US3 mobile (HTTPS) is **escalated as CA-trust-limited** per research R3 — a documented, justified deferral (emulator-CA-trust only; no unproven app/BFF path), not an unaddressed gap.

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
