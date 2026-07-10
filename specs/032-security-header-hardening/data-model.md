# Phase 1 Data Model: Security Header Hardening

This feature persists nothing. The "entities" are configuration structures (header sets and one gate-config record). They are documented here as contracts, not storage.

## Entity: Baseline security header set (web/static surface)

Applied by the `server.js` middleware to every response whose path does NOT start with `/bff-api` (CSP is path-scoped; the non-CSP headers apply to all paths).

| Field (header) | Value | Scope | Requirement |
|---|---|---|---|
| `Content-Security-Policy` | web-app policy (see contract) | non-`/bff-api` only | FR-001, FR-002 (`frame-ancestors 'none'`) |
| `X-Frame-Options` | `DENY` | all paths | FR-002 |
| `X-Content-Type-Options` | `nosniff` | all paths (incl. static) | FR-003 |
| `Referrer-Policy` | `no-referrer` | all paths | FR-004 |
| `X-Powered-By` | *(removed — `app.disable('x-powered-by')`)* | all paths | FR-010 |

**Derivation rule (CSP)**: the `connect-src` directive includes `'self'` plus the browser-facing Keycloak **origin**, resolved at process boot from env (`EXPO_PUBLIC_KEYCLOAK_URL` → `KEYCLOAK_PUBLIC_URL` → `KEYCLOAK_URL` → `http://localhost:8099`, empty-as-absent), reduced via `new URL(x).origin` (FR-007). Computed once, cached for the process lifetime.

**Validation rules**:
- CSP MUST NOT be `default-src 'none'` on the web surface (that is the API set; would blank the app).
- CSP header name MUST be `Content-Security-Policy` (enforcing), never `-Report-Only`, in the shipped state (clarification 2026-07-09).
- The Keycloak origin MUST be a valid absolute origin; a malformed env value falls back to the localhost default rather than emitting a broken directive.

## Entity: API strict header set (unchanged)

Owned by [security-headers.ts](../../frontend/mcm-app/src/bff-server/security-headers.ts); applied by each `/bff-api/*` handler's `Response`. **Not modified by this feature** — listed to document the precedence invariant.

| Field (header) | Value | Requirement |
|---|---|---|
| `Content-Security-Policy` | `default-src 'none'` | FR-005 (must remain authoritative on API) |
| `X-Frame-Options` | `DENY` | — |
| `X-Content-Type-Options` | `nosniff` | — |
| `Referrer-Policy` | `no-referrer` | — |

**Invariant (FR-006)**: on `/bff-api/*` the CSP present MUST be exactly `default-src 'none'` (one header, no duplicate). Guaranteed by path-scoping the web CSP out of `/bff-api` (research R4).

## Entity: Agent endpoint cross-origin policy

The response headers of `/bff-api/agent/run` after post-processing in [run+api.ts](../../frontend/mcm-app/src/app/bff-api/agent/run+api.ts).

| Field (header) | Before | After | Requirement |
|---|---|---|---|
| `Access-Control-Allow-Origin` | permissive (wildcard/reflected, runtime-emitted) | **absent (deleted)** | FR-008 |
| `Access-Control-Allow-Credentials` | possibly present | absent (deleted, defensive) | FR-008 |
| streaming/content headers (`Content-Type`, transfer-encoding, AG-UI stream) | present | **unchanged** | FR-009 |

**Validation rule**: after the run completes, `response.headers.get('access-control-allow-origin')` MUST be `null`. Deleting an absent header is a no-op (idempotent).

## Entity: Scan allowlist entry (gate config)

One record appended to [security/zap/allowlist.yaml](../../security/zap/allowlist.yaml) (consumed by `scripts/check-dast-findings.mjs`).

| Field | Value | Rule |
|---|---|---|
| `pluginId` | `"10096"` | required; stable ZAP rule id |
| `uriPattern` | `"http://.*/_expo/static/.*"` | required; scoped to the JS bundle path (no blanket `*`) |
| `justification` | non-empty text (build-artifact timestamps, not secrets) | required; blank → gate error |
| `addedBy` | `"steve"` | required; blank → gate error |

**Behavioral rule (FR-012 / SC-006)**: the entry removes the finding from the merge-gate result but NOT from the ZAP HTML/JSON report — suppression ≠ deletion.

## State / lifecycle

None. All structures are computed at process boot (header sets) or evaluated at scan time (allowlist). No transitions, no persistence, no migration.
