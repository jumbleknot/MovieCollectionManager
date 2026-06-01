# Implementation Plan: E2E Tests Against the BFF Docker Container

**Branch**: `007-e2e-bff-container` | **Date**: 2026-06-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/007-e2e-bff-container/spec.md`

## Summary

Prove the app's web + mobile E2E suites pass when the BFF is hosted as a **Docker container** (not Metro), in two configurations, then return to normal dev:

1. **Dev container (P1)** — run the existing BFF image with `NODE_ENV=development` (→ non-Secure cookies, plain HTTP). Web: container serves client + `/bff-api` on a port; Playwright targets it. Mobile: Metro keeps serving the JS bundle while the app's `/bff-api` calls are pointed at the container on a **separate port**. A response marker proves the request path is the container, not Metro.
2. **Test-instruction update (P2)** — document container-deploy → final E2E as a **local** step; all other phases stay on Metro. No CI E2E job.
3. **Prod container (P2)** — run `NODE_ENV=production` (Secure cookies) behind a **TLS-terminating proxy** (self-signed, trusted in the run). Reconcile the known prod blockers (login-response streaming, token refresh, SSO logout) so the full authenticated lifecycle passes. Security review confirms hardening intact. Mobile-over-HTTPS needs the emulator to trust the test CA.
4. **Cleanup (P3)** — switch back to Metro; remove only the BFF (+ proxy) containers, leaving the persistent stack intact.

Relies on the **feature-006 issuer fix** (runtime `KEYCLOAK_URL`/`KEYCLOAK_PUBLIC_URL`) already on `main`.

## Technical Context

**Language/Version**: TypeScript 6 on Node 24.14.1; Expo SDK 56 / RN 0.85; the BFF runs as the Expo Router server (`server.js` + `@expo/server/adapter/express`) in a `node:24.14.1-alpine3.23` container.

**Primary Dependencies**: existing `mcm-bff:latest` image (`frontend/mcm-app/Dockerfile`); Docker Compose `bff` profile (`infrastructure-as-code/docker/bff/compose.yaml`); Playwright (web E2E), Maestro (mobile E2E); a **TLS-terminating reverse proxy** for the prod path (Caddy or nginx — chosen in research); the full backend stack (Keycloak+Postgres, MongoDB, mc-service, Redis).

**Storage**: N/A (no data-model change).

**Testing**: existing web E2E (Playwright, `tests/e2e/web/`) + mobile E2E (Maestro, `tests/e2e/mobile/`), run against the container instead of Metro; a new prod-lifecycle test (login → access-token expiry → transparent refresh → logout incl. SSO).

**Target Platform**: Web (browser) + Android (emulator); BFF in a Linux container locally.

**Project Type**: Mobile + web frontend app with a containerized BFF; this feature is test/deployment validation + a small amount of prod-server reconciliation.

**Performance Goals**: N/A. Reliability: container-served web removes the dev-Metro JIT flakiness that limited feature-006 SC-003 → web E2E should now be reliably green.

**Constraints**: no end-user behavior change (FR-009); **prod hardening must not be weakened for tests** (FR-007 — Secure cookies kept, satisfied via HTTPS); the dev-container cookie relaxation is the **existing dev posture** (`auth.ts` already emits non-Secure cookies when `NODE_ENV=development`), not a new relaxation; Metro and the container cannot share a port (mobile dual-port); the issuer fix from 006 must stay intact.

**Scale/Scope**: 92 web E2E + 20 mobile flows run against the container; ~2 new compose services (dev-container variant, prod TLS proxy), a BFF-source response marker, an E2E target-selection mechanism, a prod-lifecycle test, doc + cleanup updates, and the prod reconciliation (login streaming / refresh / SSO logout) gated by a spike.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Relevance | Status |
|---|---|---|
| **Security — Session Management (HttpOnly/Secure/SameSite=Strict cookies)** | Prod container keeps `Secure` and is served over **HTTPS** (TLS) — fully compliant. Dev container uses non-Secure cookies = the **existing** dev/Metro posture (`auth.ts` `secure` gated on `NODE_ENV`), not a new violation. FR-007 forbids disabling `Secure` for tests. | ✅ |
| **Security — Transport (TLS 1.3 / HSTS)** | Prod path adds a TLS front (self-signed for local E2E); HTTP remains only the local dev posture (as today). Real prod uses proper certs. | ✅ |
| **Security review required** | FR-008 / constitution: a security review runs on the prod-reconciliation changes; High/Critical resolved before completion. | ✅ (planned) |
| **TDD + Test Type Integrity (no mocking in E2E)** | E2E runs against the **real** container — stronger, not weaker. New prod-lifecycle test added TDD-style (RED before GREEN). | ✅ |
| **Docker-Native Operations / Compose profiles** | Adds container variants via existing compose `include:`/profiles; aligns with the constitution's "BFF runs in Docker" architecture (this feature *validates* it). | ✅ |
| **pnpm + Nx primary invocation** | All build/test ops via Nx targets (`docker-build`, `e2e`, `e2e:mobile`); container build is the existing `mcm-app:docker-build`. | ✅ |
| **No new end-user functionality** | FR-009 — validation + minimal prod-server reconciliation only. | ✅ |
| **Docs current** | FR-004/FR-013 — CLAUDE.md + quickstart updated. | ✅ |

**Result: PASS.** No principle diluted. The only "relaxation" (dev-container non-Secure cookies) equals the existing dev posture; prod stays compliant via HTTPS. Complexity Tracking empty.

## Project Structure

### Documentation (this feature)

```text
specs/007-e2e-bff-container/
├── plan.md              # This file
├── research.md          # Phase 0 — dev-container config, mobile dual-port, prod TLS, marker, prod reconciliation
├── data-model.md        # Phase 1 — N/A entities; config/infra artifacts catalog
├── quickstart.md        # Phase 1 — operator runbook (dev-container E2E, prod-container E2E, cleanup)
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
# Compose — container variants for E2E
infrastructure-as-code/docker/bff/compose.yaml   # add a dev-config service (NODE_ENV=development) + a prod TLS proxy service
infrastructure-as-code/docker/bff/                # + reverse-proxy config (Caddyfile/nginx.conf) + self-signed cert generation
compose.yaml (root)                               # new profiles: bff-dev / bff-prod (via include + profiles)

# BFF — observable "which server am I" marker (US1/US3 FR-002)
frontend/mcm-app/server.js                        # emit a response header from an env var (e.g. X-BFF-Source=dev-container|prod-container)

# Prod reconciliation (US3 FR-006/FR-007) — only what the spike proves necessary
frontend/mcm-app/src/bff-server/*                 # login-response streaming / token-refresh / SSO-logout fixes (scoped by the spike)

# E2E harness — target the container instead of Metro
frontend/mcm-app/playwright.config.ts             # env-driven baseURL + skip webServer auto-start when targeting a container; ignoreHTTPSErrors for prod
frontend/mcm-app/tests/e2e/web/setup/global-setup.ts   # assert the BFF-source marker; keep session reuse
frontend/mcm-app/scripts/maestro-e2e.mjs          # support container BFF on a separate port (EXPO_PUBLIC_BFF_NATIVE_URL + adb reverse <port>)
frontend/mcm-app/tests/e2e/web/<prod-lifecycle>.spec.ts  # new: login -> token-expiry refresh -> logout (Playwright fake clock)

# Mobile JS-bundle vs BFF split (FR-002 mobile)
# Metro serves JS on :8081 (adb reverse 8081); container serves /bff-api on :<bff-port> (adb reverse <bff-port>);
# Metro started with EXPO_PUBLIC_BFF_NATIVE_URL=http://localhost:<bff-port> so the bundle's BFF calls hit the container.

# Docs
CLAUDE.md                                         # testing instructions: container build/deploy before the FINAL local E2E; cleanup
```

**Structure Decision**: No new application source dirs. Changes are: compose service/profile additions + a TLS proxy config under `infrastructure-as-code/docker/bff/`; a one-line response marker in `server.js`; an env-driven E2E target mechanism in `playwright.config.ts` + the Maestro runner; a new prod-lifecycle web spec; doc updates; and a **bounded, spike-gated** set of `bff-server` fixes for the prod login/refresh/logout reconciliation (only what the spike proves necessary). The dev-container path needs essentially no app-code change (runtime `NODE_ENV=development` + ports).

## Complexity Tracking

> No Constitution Check violations — section intentionally empty.
