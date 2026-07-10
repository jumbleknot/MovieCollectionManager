# Implementation Plan: Security Header Hardening (DAST remediation)

**Branch**: `032-security-header-hardening` | **Date**: 2026-07-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/032-security-header-hardening/spec.md`

## Summary

Close the missing-security-header and permissive-CORS findings from the feature-031 DAST baseline scan by:

1. Adding a **global baseline security-header middleware** to the Expo BFF's Express adapter ([frontend/mcm-app/server.js](../../frontend/mcm-app/server.js)) — the one layer proven to reach all three response classes (static assets, SSR HTML, `/bff-api/*`). It sets a web-app Content-Security-Policy (enforcing), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and removes `X-Powered-By`. (The **final** shipped CSP — settled during T006 report-only validation: strict hash-only `script-src` plus `form-action 'self'`, no `'unsafe-inline'`/`'unsafe-eval'` on scripts — is recorded authoritatively in [contracts/security-headers-contract.md](./contracts/security-headers-contract.md); research R2 below is the starting policy it was tightened from.) The web-app CSP is **path-scoped to non-`/bff-api` requests** so the existing strict `default-src 'none'` API policy set by [security-headers.ts](../../frontend/mcm-app/src/bff-server/security-headers.ts) stays authoritative on the API surface (deterministic, no reliance on same-name merge order).
2. **Dropping the `Access-Control-Allow-Origin` header** from the CopilotKit runtime response in [run+api.ts](../../frontend/mcm-app/src/app/bff-api/agent/run+api.ts) by wrapping `handleRequest(req)` and deleting the header from the returned `Response` before returning it — streaming body and all other headers untouched.
3. **Verifying HSTS** on the prod-secure edge. The existing [Caddyfile](../../infrastructure-as-code/docker/bff/Caddyfile) already emits `Strict-Transport-Security: max-age=31536000; includeSubDomains` (line 27) and the plain-HTTP dev/CI BFF sets none — so this is confirmation, not new work, plus a check that the production edge in front of `mcm.<domain>` carries the same header.
4. **Allowlisting** the confirmed timestamp-disclosure false positive (ZAP 10096) scoped to `/_expo/static/.*` in [security/zap/allowlist.yaml](../../security/zap/allowlist.yaml).

TDD: a RED unit test on the new header-builder module + a Playwright response-header assertion (on `/` and a static asset) proving presence of the baseline headers and absence of `X-Powered-By`, then implement to GREEN, then re-run the DAST baseline and the web E2E regression.

## Technical Context

**Language/Version**: TypeScript 5.x (BFF route handlers) + CommonJS Node.js (`server.js` adapter), Node 24.14.1; Playwright + Jest for tests. Caddy 2 (prod edge, config-as-code).

**Primary Dependencies**: Express (via `@expo/server/adapter/express`), `@copilotkit/runtime` (agent route), OWASP ZAP + `scripts/zap-scan.mjs` / `scripts/check-dast-findings.mjs` (feature 031). **No new runtime dependency** — headers are set via `res.setHeader` / `app.disable('x-powered-by')`; `helmet` is intentionally NOT added (its value is a curated default set; our CSP is bespoke and the rest is four static headers, so a dependency buys nothing and would still need full CSP customization).

**Storage**: N/A (no data model change).

**Testing**: Jest unit test on the plain-JS header-builder module (RED→GREEN); Playwright web E2E response-header assertion (`pnpm nx e2e mcm-app`); DAST baseline re-run (`pnpm nx dast infrastructure-as-code`); manual browser CSP-console check; agent web+mobile E2E for the CORS change.

**Target Platform**: Web (browser) is the only affected surface. Native mobile is unaffected (browsers enforce CSP; RN does not).

**Project Type**: Web application (React Native/Expo frontend with an Expo Router BFF running server-side in a Node container).

**Performance Goals**: No measurable latency impact — setting four static response headers + one computed CSP string per request. CSP string is computed once at process start (Keycloak origin read from env at boot), not per request.

**Constraints**:

- `@expo/server@0.5.3` (SDK 56) does NOT run `+middleware.ts` — the Express `app.use` layer in `server.js` is the ONLY viable global injection point (documented runtime gap, feature 010; memory `project_expo_server_middleware_gap`).
- The API surface MUST keep `Content-Security-Policy: default-src 'none'` (FR-005). Achieved by path-scoping the web CSP to non-`/bff-api` requests.
- CSP `connect-src` / navigation must permit the browser-facing Keycloak origin, sourced from env (`EXPO_PUBLIC_KEYCLOAK_URL` → `KEYCLOAK_PUBLIC_URL` → `KEYCLOAK_URL` → localhost default), never hard-coded (FR-007).
- Delivered CSP is **enforcing** (`Content-Security-Policy`), not `Content-Security-Policy-Report-Only` (clarification 2026-07-09).

**Scale/Scope**: ~4 source files touched (`server.js` + a new plain-JS header module, `run+api.ts`, `allowlist.yaml`), plus tests. Single small PR (HSTS verification is config-confirmation only).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**§Security → Transport Security → Security Headers** — REQUIRES `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` on all HTTP responses. This feature ADDS them to the previously-uncovered web/static surface. ✅ Directly advances compliance.

**§Security → Transport Security → CORS** — "Restrict `Access-Control-Allow-Origin` to explicitly allow-listed trusted origins. Wildcard origins prohibited on authenticated endpoints." Dropping the header on the same-origin agent endpoint removes a permissive allowance. ✅ Advances compliance.

**§Security → Transport Security → HSTS** — "All services must include `Strict-Transport-Security`." Already satisfied at the HTTPS edge (Caddy); this feature verifies it. ✅ Compliant.

**§Security → Authorization → Centralized Access Control** — the change is header-only and does NOT touch the per-request auth on `/bff-api/*`. The agent-route change only deletes a response header AFTER the existing `requireAuth`/`requireMcUser` gate. ✅ No regression; auth path unchanged (FR-013).

**§Test-Driven Development (NON-NEGOTIABLE)** — RED test before implementation (unit header-builder test + Playwright assertion). Verify-RED / Verify-GREEN commands go in tasks.md. ✅ Planned.

**§Frontend Quality → Consistent E2E across clients / Platform Parity** — CSP is a web-only concern; mobile parity entry will be documented as N/A with justification (browsers enforce CSP, RN does not) in the Platform Parity Table. ✅ Planned.

**§AI Assistant Constraints → Behavior-Descriptive Identifiers** — new module/function named for behavior (e.g. `buildWebSecurityHeaders` / `web-security-headers.js`), no `FR-###` in identifiers; governing-requirement provenance in a JSDoc comment. ✅ Planned.

**§Frontend → Logging** — no new logging; the header middleware is side-effect-free. ✅.

**Result: PASS.** No violations. No Complexity Tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/032-security-header-hardening/
├── plan.md              # This file
├── research.md          # Phase 0 output — CSP directive resolution, header precedence, CORS strip point
├── data-model.md        # Phase 1 output — header-set definitions (config entities, no persistence)
├── quickstart.md        # Phase 1 output — validation/run guide
├── contracts/
│   └── security-headers-contract.md   # exact header names/values per surface + agent CORS contract
├── checklists/
│   └── requirements.md  # spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
frontend/mcm-app/
├── server.js                              # EDIT: add global baseline-header middleware + app.disable('x-powered-by')
├── web-security-headers.js                # NEW: plain-CommonJS builder — computes the web-app CSP + static header set from env (required by server.js)
├── web-security-headers.test.js           # NEW: Jest RED→GREEN unit test on the builder (header names/values, API path-scope, x-powered-by absence)
├── src/
│   ├── app/bff-api/agent/run+api.ts        # EDIT: strip Access-Control-Allow-Origin from the CopilotKit runtime Response
│   └── bff-server/security-headers.ts      # UNCHANGED (API strict set stays authoritative) — referenced only
└── tests/e2e/web/
    └── security-headers.spec.ts            # NEW: Playwright — assert baseline headers on `/` + a static asset; x-powered-by absent; API CSP still strict

infrastructure-as-code/docker/bff/
└── Caddyfile                              # VERIFY ONLY: HSTS already present (line 27); confirm prod edge parity

security/zap/
└── allowlist.yaml                         # EDIT: add pluginId 10096 entry scoped to /_expo/static/.*
```

**Structure Decision**: Web-application layout, all changes localized to `frontend/mcm-app/` (the affected BFF) plus the `security/zap/` gate config. The header builder is a **plain CommonJS module** (`web-security-headers.js`) — NOT under `src/` — because `server.js` is the hand-written CommonJS adapter that `require()`s at container boot and cannot import the app's compiled TS; keeping the builder as a sibling plain-JS module makes it unit-testable in isolation while remaining directly requirable by `server.js`. This is the same layer that already stamps `X-BFF-Source`, so it inherits the proven "reaches static + SSR + API" property.

## Complexity Tracking

No constitution violations — section intentionally empty.
