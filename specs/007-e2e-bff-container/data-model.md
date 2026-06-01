# Phase 1 Data Model: E2E Against the BFF Docker Container

**No domain data entities.** This feature changes test/deployment validation and BFF runtime configuration; it introduces, removes, or modifies zero application data entities, fields, or relationships (FR-009). In place of a domain model, the relevant artifacts are the **configuration / infrastructure** elements this feature touches.

| Artifact | Location | Change | Serves |
|---|---|---|---|
| Dev BFF compose service | `infrastructure-as-code/docker/bff/compose.yaml` | New service: `mcm-bff:latest`, `NODE_ENV=development`, HTTP, `BFF_SOURCE=dev-container`, host port `:8082`; profile `bff-dev` | US1 / FR-001 |
| Prod TLS proxy service | `infrastructure-as-code/docker/bff/compose.yaml` + `Caddyfile`/cert | New `caddy` (or nginx) service terminating TLS in front of `mcm-bff` (`NODE_ENV=production`, `BFF_SOURCE=prod-container`); profile `bff-prod` | US3 / FR-005, FR-007 |
| Root compose profiles | `compose.yaml` | Add `bff-dev` / `bff-prod` via `include:` + `profiles` | US1/US3 |
| BFF-source marker | `frontend/mcm-app/server.js` | Emit `X-BFF-Source: ${BFF_SOURCE}` response header on all responses | FR-002 |
| Web E2E target switch | `frontend/mcm-app/playwright.config.ts` | `E2E_BFF_TARGET` → set `baseURL`, disable Metro `webServer`, `ignoreHTTPSErrors` for prod | US1/US3 / FR-002, FR-003 |
| Web global-setup marker assert | `tests/e2e/web/setup/global-setup.ts` | Assert `X-BFF-Source` before trusting the run; keep session reuse + warm-up | FR-002 |
| Mobile runner dual-port | `frontend/mcm-app/scripts/maestro-e2e.mjs` | `EXPO_PUBLIC_BFF_NATIVE_URL=http://localhost:<bff-port>` + `adb reverse tcp:<bff-port>`; Metro on `:8081` | FR-002 (mobile) |
| Prod-lifecycle web test | `tests/e2e/web/<prod-lifecycle>.spec.ts` | New: login → token-expiry refresh → logout (fake clock) | US3 / FR-006 |
| Prod reconciliation (spike-gated) | `frontend/mcm-app/src/bff-server/*` | Minimal login-streaming / refresh / SSO-logout fixes the R6 spike proves necessary | US3 / FR-006, FR-007 |
| Testing instructions | `CLAUDE.md` | Container build/deploy before the **final local** E2E; Metro for all else; cleanup steps | US2/US4 / FR-004, FR-010 |

### Invariants / validation rules (behavioral, not data)

- **Request-path proven**: every trusted E2E run records the `X-BFF-Source` marker = `dev-container` or `prod-container` (never Metro) — SC-001/SC-004.
- **No hardening weakened**: prod path keeps `Secure` cookies + HTTPS; `Secure` is never disabled for tests (FR-007, SC-005).
- **Dev posture unchanged**: dev-container non-Secure cookies == existing Metro/dev behavior (not a regression).
- **No behavior change**: pre-existing unit/integration/mc-service suites stay green (FR-011, SC-006).
- **Clean teardown**: only BFF + proxy containers removed; persistent external volumes + shared stack intact (SC-007).
