# HANDOFF — Feature 032: Security Header Hardening (DAST remediation)

**For**: a fresh implementation session. **State as of**: 2026-07-09. **Branch**: `032-security-header-hardening` (already checked out; SDD artifacts committed as `7826398`).

## What this is

Remediate the missing-security-header + permissive-CORS findings from the feature-031 DAST baseline scan. **App-layer only, additive hardening — no auth/authz/session change.** Single small PR.

## Read first (in order)

1. [spec.md](./spec.md) — WHAT/WHY (FR-001..015, SC-001..008, US1–US3, 3 clarifications).
2. [plan.md](./plan.md) — HOW (injection layer, precedence, CORS strip, Constitution Check PASS).
3. [research.md](./research.md) — R1–R8 decisions (CSP directives, Keycloak-origin sourcing, path-scoping, HSTS-already-present).
4. [tasks.md](./tasks.md) — **execution list T001–T014 with TDD RED/GREEN checkpoints. Follow it in order.**
5. [contracts/security-headers-contract.md](./contracts/security-headers-contract.md) — exact header values per surface (the test oracle).
6. [quickstart.md](./quickstart.md) — validation commands.
7. The source PRD: [docs/PRD-SecurityHeaderHardening.md](../../docs/PRD-SecurityHeaderHardening.md).

Also read the repo `CLAUDE.md` (esp. §Test Run Protocol, §Final local E2E against the BFF container, DAST section) and skim the private memory index for the middleware-gap + DAST lessons.

## The 4 changes (all in `frontend/mcm-app/` + `security/zap/`)

| # | File | Change | Story |
|---|---|---|---|
| 1 | `web-security-headers.js` (NEW, CommonJS) + `server.js` (EDIT) | Global baseline-header middleware: enforcing web CSP + `X-Frame-Options: DENY` + `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer`, and `app.disable('x-powered-by')`. CSP **path-scoped to non-`/bff-api`**. | US1 (P1, MVP) |
| 2 | `src/app/bff-api/agent/run+api.ts` (EDIT) | Delete `Access-Control-Allow-Origin` (+`-Allow-Credentials`) from the CopilotKit `handleRequest` Response. | US2 (P2) |
| 3 | `security/zap/allowlist.yaml` (EDIT) | Add ZAP `10096` entry scoped to `/_expo/static/.*`. | US3 (P3) |
| 4 | `infrastructure-as-code/docker/bff/Caddyfile` | **VERIFY ONLY** — HSTS already on line 27. | US3 (P3) |

## Load-bearing gotchas (do NOT relearn the hard way)

- **`server.js` is CommonJS and CANNOT import the app's compiled TS.** The header builder must be a plain-JS sibling module it `require()`s. (plan Structure Decision / research R1.)
- **`+middleware.ts` is a dead end** — `@expo/server@0.5.3` ignores it at runtime (memory `project_expo_server_middleware_gap`). `server.js` `app.use` is the ONLY global injection point; it's proven to reach static + SSR + API by the existing `X-BFF-Source` marker.
- **Keep the API CSP strict.** `/bff-api/*` must stay `Content-Security-Policy: default-src 'none'` (FR-005). Achieved by path-scoping the web CSP out of `/bff-api` — do NOT rely on adapter same-name merge order.
- **CSP is the real risk.** A too-strict policy blanks the web app. Start with research R2's directive set; if unsure of `script-src`/`worker-src`, use `Content-Security-Policy-Report-Only` locally to discover violations, then **ship enforcing** (clarification: report-only is a dev aid, never the delivered state). Validate with the web E2E **and** a manual browser console (zero CSP violations).
- **Keycloak origin for `connect-src` comes from env, not hard-coded** (FR-007): `EXPO_PUBLIC_KEYCLOAK_URL || KEYCLOAK_PUBLIC_URL || KEYCLOAK_URL || http://localhost:8099` (empty-as-absent), reduced to `new URL(x).origin`. Confirm the dev-container profile passes the browser-facing origin (`localhost:8099`, not internal `keycloak-service:8080`). T001.
- **T007 is a hard gate before T008** (analysis finding T1): first curl `/bff-api/agent/run` (authenticated) to see what `Access-Control-*` it actually emits. If it emits an ACAO header → normal RED→GREEN. If it emits none → T008 becomes an idempotent-absence regression guard (a never-RED test isn't TDD); the T009 delete is still correct/idempotent.
- **Rebuild the BFF image before any container E2E or the DAST re-run** (`pnpm nx docker-build mcm-app`) — a stale image validates old code (feature 011 lesson).
- **HSTS is edge-owned (Caddy), already present.** Never set it in `server.js` (it would emit on plain-HTTP dev/CI, which is wrong). US3 = verify only.
- **Mobile is unaffected** (browsers enforce CSP; RN does not). Platform Parity Table already marks the header rows N/A with justification; only agent streaming (US2) is covered on both web + mobile.

## Recommended order

1. **T001** (confirm env) → **US1** (T002 RED unit → T003 builder → T004 RED E2E → T005 wire server.js → T006 browser-validate + finalize enforcing CSP). **This is the MVP** — closes F1/F2/F3/F4.
2. **US2** (T007 verify → T008 test → T009 strip) — closes F5.
3. **US3** (T010 allowlist, T011 HSTS verify, T012 DAST re-run) — closes F6 + confirms F1–F5 gone.
4. Polish (T013 docs, T014 full regression + `rtk gain`).

## Key commands

```powershell
# env prerequisite
pnpm nx up-auth infrastructure-as-code           # Keycloak (CSP connect-src + login)

# US1 TDD
pnpm nx test mcm-app -- --testPathPattern web-security-headers          # unit RED/GREEN
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/security-headers.spec.ts

# container path (rebuild first!)
pnpm nx docker-build mcm-app
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile bff-nonsecure up -d

# DAST re-run + final
pnpm nx dast infrastructure-as-code
pnpm nx e2e mcm-app ; pnpm nx test mcm-app ; rtk gain
```

## Definition of done

All SC-001..008 in the Completion Checklist at the bottom of [tasks.md](./tasks.md). Then open the PR **to the forge `origin` `main`** (not the GitHub mirror) per CLAUDE.md — the app-ci `paths:` already covers `frontend/**`, `infrastructure-as-code/**`, and `security/**`? **Verify** `security/zap/**` is in app-ci's `pull_request` `paths` (feature-031 added the DAST job); if the only change were the allowlist it could otherwise skip CI. This PR touches `frontend/**` regardless, so app-ci will run.

## Prerequisite for the session

RTK active (`rtk gain` > 80% after a test run) — constitution requirement.
