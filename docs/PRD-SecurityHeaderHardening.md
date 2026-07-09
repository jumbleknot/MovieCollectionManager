# PRD: Security Header Hardening (DAST remediation)

**Status**: Draft · **Author**: (from feature 031 DAST findings) · **Date**: 2026-07-09
**Source**: OWASP ZAP baseline scan shipped in feature 031 (`security/zap/`, PR #45).
**Related**: [docs/PRD-CleanExpoRouter.md](./PRD-CleanExpoRouter.md) Issue 3 (the `+middleware.ts` runtime gap this PRD must work around), [security/zap/README.md](../security/zap/README.md).

---

## 1. Problem

The feature-031 DAST baseline scan (authenticated, against the BFF) reported a set of missing
HTTP security response headers plus one CORS misconfiguration. None are High — the CI gate passes —
but they are real hardening gaps we should close, and they are exactly the class of issue the DAST
scan exists to surface (constitution §Transport Security / §Infrastructure Hardening).

### Findings to remediate

| # | ZAP rule | Risk | Finding | Where observed |
|---|---|---|---|---|
| F1 | 10038 | Medium | Content Security Policy (CSP) header not set | Expo-served HTML (`/`, `/robots.txt`) |
| F2 | 10020 | Medium | Missing Anti-clickjacking header (X-Frame-Options / CSP `frame-ancestors`) | Expo-served HTML |
| F3 | 10021 | Low | `X-Content-Type-Options: nosniff` missing | Expo-served HTML + static assets |
| F4 | 10037 | Low | Server leaks `X-Powered-By: Express` | all Express responses |
| F5 | 10098 | Medium | Cross-Domain Misconfiguration (permissive `Access-Control-Allow-Origin`) | `/bff-api/agent/run` |
| F6 | 10096 | Low | Timestamp Disclosure (Unix) | JS bundle (`/_expo/static/js/...`) — **false positive** |
| F7 | 10109 | Info | Modern Web Application | informational — **no action** |

## 2. Root cause

The BFF **already sets** CSP (`default-src 'none'`), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer` — but **only inside the
`/bff-api/*` route handlers**, via `securityHeaders()` ([src/bff-server/security-headers.ts](../frontend/mcm-app/src/bff-server/security-headers.ts)).

The **Expo-served surface has no such headers**: the web-app HTML shell (SSR via Expo Router) and the
static assets (served by `express.static`) never pass through a `securityHeaders()` call. F1/F2/F3 all
fire on that surface. F4 (`X-Powered-By`) is Express's default on every response.

**F5** is separate: `/bff-api/agent/run` hosts the CopilotKit runtime
(`copilotRuntimeNextJSAppRouterEndpoint`, [run+api.ts](../frontend/mcm-app/src/app/bff-api/agent/run+api.ts)).
The runtime builds its own `Response` (only the early 200 handshake uses `securityHeaders()`), so
whatever CORS headers CopilotKit emits pass through unmodified.

## 3. Constraints (READ FIRST — these shape the design)

1. **`@expo/server@0.5.3` (SDK 56 pin) does NOT invoke `+middleware.ts` at runtime** (feature 010,
   FR-018; [docs/PRD-CleanExpoRouter.md](./PRD-CleanExpoRouter.md) Issue 3;
   `memory: project_expo_server_middleware_gap`). `expo export` emits the middleware; the adapter
   ignores it. **So Expo Router global middleware is NOT a viable mechanism** — do not reach for it.
2. **The working layer is `server.js`'s Express `app.use` middleware.** [server.js](../frontend/mcm-app/server.js)
   already stamps `X-BFF-Source` on *every* response (static, SSR HTML, and `/bff-api/*` — the web
   E2E asserts it on `/bff-api/auth/init`). That proves an Express-level `app.use` reaches all three
   surfaces and that its headers survive on API routes unless a handler sets the **same** header name.
   This is the injection point.
3. **CSP must not break the Expo web app.** The API's `default-src 'none'` is correct for JSON but
   would blank the web app (it needs its own scripts/styles/fonts and `connect-src` to the BFF +
   Keycloak). The HTML surface needs a *real* web-app CSP, so a single global `default-src 'none'`
   is wrong. Getting the CSP right without breaking the app is the main risk — it must be validated
   by the web E2E (and manually in a browser).
4. **Header precedence is intentional and must be preserved.** `server.js` sets baseline headers on
   all responses; the `/bff-api/*` handlers' `securityHeaders()` must keep **overriding** them for
   the API (strict `default-src 'none'` on JSON). Confirmed possible: same-name headers set by the
   handler `Response` win; differently-named `server.js` headers (like `X-BFF-Source`) persist.
5. **Prod runs behind Caddy (HTTPS); dev/CI container is plain HTTP `:8082`.** HSTS only makes sense
   on the HTTPS edge → set it at Caddy, not in `server.js` (an HSTS header on plain HTTP is ignored
   and can misconfigure). Everything else is app-layer so it applies to both.
6. **No behavioral regression to auth.** This is additive header hardening; the BFF's per-handler
   auth and `securityHeaders()` on `/bff-api/*` stay unchanged.

## 4. Proposed solution

### 4.1 Global baseline headers in `server.js` (F1, F2, F3, F4)

Add one Express `app.use` (alongside the existing `X-BFF-Source` one, **before** `express.static`
and `app.all('*')`) that sets, on every response:

- `Content-Security-Policy`: a web-app policy that allows the Expo bundle to run. Starting point to
  iterate against the web E2E (tighten from here):
  - `default-src 'self'`
  - `script-src 'self'` (+ `'wasm-unsafe-eval'` only if Hermes/web needs it — verify)
  - `style-src 'self' 'unsafe-inline'` (React Native Web / Tamagui inject inline styles — likely required)
  - `img-src 'self' data: https:` (TMDB poster URLs, data URIs)
  - `font-src 'self' data:`
  - `connect-src 'self'` + the Keycloak origin(s) the browser talks to (dev `http://localhost:8099`,
    prod `https://auth.<domain>`) — sourced from the existing `EXPO_PUBLIC_KEYCLOAK_URL`, not hardcoded
  - `frame-ancestors 'none'` (covers F2 via CSP), `base-uri 'self'`, `object-src 'none'`
- `X-Frame-Options: DENY` (belt-and-suspenders with `frame-ancestors` for old browsers) — F2
- `X-Content-Type-Options: nosniff` — F3
- `Referrer-Policy: no-referrer`
- `app.disable('x-powered-by')` (or delete the header in the middleware) — F4

Because the `/bff-api/*` handlers set their **own** CSP/XFO/nosniff via `securityHeaders()`, the API
keeps its strict `default-src 'none'`; the new global values apply to the HTML shell + static assets
only. (Verify this precedence holds for SSR HTML responses too — see Open Questions.)

**Consider `helmet`** as the implementation instead of hand-rolled `setHeader` calls — it is the
standard, well-audited Express middleware for exactly this. Decision left to implementation; either
is acceptable if the CSP is correct.

### 4.2 HSTS at Caddy (prod only)

Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` at the Caddy reverse proxy in
front of the prod BFF. Not in `server.js` (dev/CI is HTTP). (ZAP didn't flag HSTS because the scan
ran against the non-secure `:8082` container; re-check against the prod-secure container.)

### 4.3 Tighten `/bff-api/agent/run` CORS (F5)

1. **Verify at runtime** what `Access-Control-Allow-Origin` (and related `Access-Control-*`) the
   CopilotKit runtime emits on `/bff-api/agent/run` (curl the endpoint; inspect the response). ZAP
   10098 fires on an over-permissive value (typically `*`, or reflecting the Origin).
2. The BFF and the web client are **same-origin** (the app calls its own `/bff-api/*`), so a
   permissive cross-origin policy is unnecessary. Remediate by post-processing the CopilotKit
   `Response` in `run+api.ts` to remove/normalize the `Access-Control-Allow-Origin` header (drop it,
   or scope it to the app origin) before returning — mirroring how the route already wraps the
   runtime handler. Keep the AG-UI streaming behavior intact.

### 4.4 Allowlist the timestamp-disclosure false positive (F6)

Add an entry to [security/zap/allowlist.yaml](../security/zap/allowlist.yaml):
`pluginId: "10096"`, `uriPattern` scoped to `/_expo/static/.*`, with a justification (Unix timestamps
in the compiled JS bundle are not secrets), `addedBy`. Keeps it visible in reports, out of the gate.

### 4.5 F7 — no action (informational).

## 5. Out of scope / non-goals

- Rewriting the BFF `/bff-api/*` `securityHeaders()` (already compliant).
- Re-attempting the `+middleware.ts` centralization (that is the separate CleanExpoRouter follow-up;
  the two re-attempt paths live in `memory: project_expo_server_middleware_gap`). This PRD deliberately
  uses `server.js` (Express layer), which is known to work today.
- Active-scan-only or gateway/mc-service findings (the passive baseline reported none of note on those;
  the CI full scan already exercises them and is gated).

## 6. Validation & acceptance criteria

- [ ] **Re-run the DAST baseline** (`pnpm nx dast infrastructure-as-code`) → F1, F2, F3, F4 no longer
      reported on the BFF; F6 suppressed by the allowlist (still visible in the report). F5 gone after
      the CORS fix (verify against `/bff-api/agent/run`).
- [ ] **Web E2E stays green** (`pnpm nx e2e mcm-app`) — the CSP must not break the web app. This is
      the primary regression risk; a too-strict CSP blanks the page (blocked scripts/styles). Iterate
      the policy until E2E is green **and** a manual browser load shows no CSP console violations.
- [ ] **Mobile E2E unaffected** (native RN doesn't apply web CSP; headers are a web concern).
- [ ] **TDD**: assert the presence of the headers on a non-API route and on a static asset — either a
      BFF integration test (real `server.js`) or a Playwright response-header assertion in the E2E
      (fetch `/` and an asset, assert CSP/XFO/nosniff present and `X-Powered-By` absent). Add a RED
      test first (headers missing) → implement → GREEN.
- [ ] Re-run the **prod-secure** container scan (or verify Caddy config) to confirm HSTS present in prod.
- [ ] `check-prod-ci-port-collision.mjs` and the secret gates stay green (no infra/secret changes).

## 7. Risks

| Risk | Mitigation |
|---|---|
| CSP breaks the Expo web app (blocked scripts/styles → blank page) | Start permissive (`'self'` + `'unsafe-inline'` styles), validate via web E2E + manual browser, tighten incrementally. Ship report-only (`Content-Security-Policy-Report-Only`) first if uncertain. |
| Global header collides with an API handler header | Precedence verified (handler `Response` wins on same name); keep API `securityHeaders()` authoritative for `/bff-api/*`. |
| CopilotKit CORS fix breaks AG-UI streaming | Only strip/scope `Access-Control-Allow-Origin`; leave content-type/streaming headers untouched; re-run the agent E2E flows. |
| SSR HTML response bypasses the `express.static`/middleware ordering | Verify the middleware runs for `app.all('*')` (SSR) responses, not just static — the existing `X-BFF-Source` on SSR pages is the evidence to confirm. |

## 8. Rollout

Single small PR against `main` (branch off), app-layer only:
1. `server.js` global headers + `x-powered-by` off.
2. `run+api.ts` CORS normalization.
3. `security/zap/allowlist.yaml` timestamp entry.
4. Caddy prod config: HSTS (separate infra change, may be its own PR).
5. Tests (RED→GREEN) + re-run DAST baseline + web E2E.

Estimated size: small (a few files, no new deps unless `helmet` is chosen).

## 9. Open questions

- Does the Expo web bundle require `'wasm-unsafe-eval'` or any inline `script-src` (Hermes/web, source
  maps)? Determine empirically from browser CSP console violations.
- Exact `connect-src` set: BFF origin (self) + Keycloak; anything else the browser hits directly
  (it shouldn't — all backend calls go through the BFF)?
- Precise CopilotKit CORS header value on `/bff-api/agent/run` (runtime verification needed before
  choosing drop vs. scope-to-origin).
- `helmet` vs. hand-rolled `setHeader` — implementer's call.
