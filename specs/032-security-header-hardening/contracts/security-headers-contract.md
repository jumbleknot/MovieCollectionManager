# Contract: HTTP Security Headers by Surface

Observable HTTP response contract for the three surfaces. This is the source of truth the tests (unit + Playwright) and the DAST re-scan assert against.

## Surface 1 — Browser-rendered HTML (SSR shell, e.g. `GET /`)

**Response headers MUST include:**

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' <KEYCLOAK_PUBLIC_ORIGIN>; frame-ancestors 'none'; base-uri 'self'; object-src 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

**Response headers MUST NOT include:**

```
X-Powered-By: <anything>
```

- `<KEYCLOAK_PUBLIC_ORIGIN>` is the env-derived browser-facing Keycloak origin (e.g. `http://localhost:8099` in dev/CI, `https://auth.<domain>` in prod). Only the origin (scheme://host[:port]), no path.
- The exact `script-src` / `style-src` set may gain the minimal additions discovered during report-only validation (e.g. `wasm-unsafe-eval`, `worker-src blob:`) — the delivered header is whatever makes the app run with **zero** browser CSP-console violations, and it MUST stay enforcing (not report-only). Any addition is recorded here at implementation time.

## Surface 2 — Static assets (e.g. `GET /_expo/static/js/*`, `/favicon.ico`)

**Response headers MUST include:**

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
```

- The web-app CSP is also acceptable on static assets (they are non-`/bff-api`), but the load-bearing assertion for static is `nosniff` (F3).
- `X-Powered-By` MUST be absent.

## Surface 3 — JSON API (`/bff-api/*`, e.g. `GET /bff-api/auth/init`) — UNCHANGED, asserted

**Response headers MUST include exactly:**

```
Content-Security-Policy: default-src 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-BFF-Source: <dev-container|prod-container|...>
```

- **Invariant**: exactly ONE `Content-Security-Policy` header, value `default-src 'none'` — the web-app CSP MUST NOT appear here (FR-005/FR-006). Guaranteed by path-scoping.
- `X-Powered-By` MUST be absent.

## Surface 4 — Agent runtime (`POST /bff-api/agent/run`, `GET .../run` info)

**Response headers MUST NOT include:**

```
Access-Control-Allow-Origin: <any>
Access-Control-Allow-Credentials: <any>
```

**Response headers/body that MUST remain intact (FR-009):**

- The AG-UI streaming body (`ReadableStream`) and its `Content-Type` / transfer-encoding.
- The existing per-handler auth behavior (401/403) is unchanged — the header delete happens only on a successful `Response` after the gate.

## Surface 5 — HTTPS edge (prod-secure Caddy / prod reverse proxy)

**Response headers MUST include (HTTPS only):**

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

**Plain-HTTP dev/CI BFF (`:8082` non-secure) MUST NOT include** `Strict-Transport-Security`.

Owned by the edge ([Caddyfile](../../infrastructure-as-code/docker/bff/Caddyfile) line 27), NOT by `server.js`. Already present — verified, not added.

## Gate contract — `scripts/check-dast-findings.mjs`

- After remediation, a DAST baseline re-run reports **zero** occurrences of ZAP rules 10038 (CSP), 10020 (anti-clickjacking), 10021 (nosniff), 10037 (X-Powered-By), 10098 (CORS) on the BFF surface.
- Rule 10096 (timestamp) is **allowlisted** (still in the report, excluded from the gate).
- Gate still **fails on any un-allowlisted High** — unchanged.
