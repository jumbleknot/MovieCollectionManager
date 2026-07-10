# Quickstart / Validation Guide: Security Header Hardening

Runnable validation that proves the feature end-to-end. Implementation code lives in the source tree and `tasks.md`; this guide is the "prove it works" path. Commands are PowerShell (this machine's default shell).

## Prerequisites

- RTK active (`rtk gain` > 80% after a test run) — constitution prerequisite.
- Dev stacks per [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md): `pnpm nx up-auth infrastructure-as-code` (Keycloak) — required so the Keycloak origin resolves and login E2E works.
- For the container/DAST validation: dev-container BFF built (`pnpm nx docker-build mcm-app`) and the mcm stack `bff-nonsecure` profile up (feature 007).

## 1. Unit test — header builder (RED → GREEN)

```powershell
# RED (before implementing web-security-headers.js): the module/wiring does not exist
pnpm nx test mcm-app -- --testPathPattern web-security-headers
# Expect: FAIL (module not found / header assertions fail)

# …implement web-security-headers.js + wire into server.js…

# GREEN
pnpm nx test mcm-app -- --testPathPattern web-security-headers
# Expect: PASS — CSP string, 4 static headers, /bff-api CSP-exempt flag, x-powered-by expectation
```

Asserts the contract values in [contracts/security-headers-contract.md](./contracts/security-headers-contract.md) with a stubbed Keycloak origin.

## 2. Web E2E — headers present across surfaces (RED → GREEN)

```powershell
# RED (before wiring): baseline headers missing on / and static asset
pnpm nx e2e mcm-app -- tests/e2e/web/security-headers.spec.ts
# Expect: FAIL

# …implement…

# GREEN
pnpm nx e2e mcm-app -- tests/e2e/web/security-headers.spec.ts
# Expect: PASS
```

The spec asserts (against the running BFF): `GET /` and a static asset carry CSP/XFO/nosniff/Referrer-Policy and no `X-Powered-By`; `GET /bff-api/auth/init` still returns exactly `Content-Security-Policy: default-src 'none'`.

## 3. Manual precedence check (curl / Invoke-WebRequest)

```powershell
# Web shell → web-app CSP, one CSP header, no X-Powered-By
(Invoke-WebRequest http://localhost:8082/ -UseBasicParsing).Headers | Format-List
# Expect: Content-Security-Policy = "default-src 'self'; …; connect-src 'self' http://localhost:8099; …"
#         X-Content-Type-Options = nosniff; X-Frame-Options = DENY; Referrer-Policy = no-referrer
#         NO X-Powered-By

# API surface → strict CSP unchanged
(Invoke-WebRequest http://localhost:8082/bff-api/auth/init -UseBasicParsing).Headers['Content-Security-Policy']
# Expect: default-src 'none'   (exactly one, NOT the web policy)
```

(Port `8082` = non-secure dev container. Metro dev server on `8081` also works but does not set `X-BFF-Source`.)

## 4. Agent CORS check (FR-008/FR-009)

```powershell
# Inspect the runtime info response for the CORS allowance (authenticated session required —
# run inside the E2E-authenticated context or with a valid session cookie)
# Expect: NO Access-Control-Allow-Origin header on /bff-api/agent/run
```

Then prove streaming still works:

```powershell
pnpm nx e2e mcm-app -- tests/e2e/web/agent-search.spec.ts
# Expect: PASS (agent streaming intact)
```

Mobile agent flow (CI runs the full set; a smoke locally):

```powershell
scripts/maestro-run.sh tests/e2e/mobile/agent-navigate.yaml   # or the touched agent flow
```

## 5. Manual browser CSP-console validation (SC-002)

1. `pnpm start` in `frontend/mcm-app` → open web on `http://localhost:8081`.
2. Open DevTools console. Log in, browse collections, open a movie, open the assistant dock, run one agent turn, import/export.
3. **Expect ZERO** `Refused to load/connect/apply … Content Security Policy` violations. Any violation → add the minimal directive (see research R2), re-check. Ship only when clean AND enforcing.

## 6. DAST baseline re-run (FR-014 / SC-001)

```powershell
pnpm nx dast infrastructure-as-code
# or: node scripts/zap-scan.mjs --target local --mode baseline
```

Expect in the gate result: rules **10038, 10020, 10021, 10037, 10098 → gone** on the BFF surface; **10096 → allowlisted** (still visible in `security/zap/report.json`/HTML, excluded from the gate). Gate passes.

## 7. HSTS edge verification (FR-011 / SC-007)

```powershell
# Prod-secure Caddy edge (feature 007 secure container on :8443) — HSTS present
(Invoke-WebRequest https://localhost:8443/ -SkipCertificateCheck -UseBasicParsing).Headers['Strict-Transport-Security']
# Expect: max-age=31536000; includeSubDomains

# Plain-HTTP dev container — HSTS absent
(Invoke-WebRequest http://localhost:8082/ -UseBasicParsing).Headers.Contains('Strict-Transport-Security')
# Expect: False
```

Confirm the production reverse proxy in front of `mcm.<domain>` carries the same HSTS header (Komodo-managed edge; do not hand-edit — verify only).

## 8. Full regression (final validation)

```powershell
pnpm nx e2e mcm-app          # full web E2E — CSP must not break any flow (SC-002)
pnpm nx test mcm-app         # unit suite
# CI runs the mobile agent E2E (Metro OOMs locally after ~1–2 /run calls) — SC-008
rtk gain                     # confirm >80% compression (run last)
```

## Done / acceptance mapping

| Step | Proves |
|---|---|
| 1, 2 | FR-015 (RED→GREEN header test) |
| 3 | FR-005/FR-006 (API CSP precedence), FR-010 (no X-Powered-By) |
| 4 | FR-008/FR-009, SC-005 (agent CORS dropped, streaming intact) |
| 5 | FR-001, SC-002 (enforcing CSP, app works, zero console violations) |
| 6 | FR-014, SC-001, FR-012/SC-006 (findings gone, 10096 allowlisted) |
| 7 | FR-011, SC-007 (HSTS present on HTTPS, absent on HTTP) |
| 8 | SC-002, SC-003, SC-008 (no web/mobile regressions) |
