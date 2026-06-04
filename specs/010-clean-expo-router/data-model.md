# Phase 1 Data Model: Clean Expo Router

This feature introduces **no new persisted entities** and **no schema changes**. It changes request routing, error-boundary logging, and access enforcement only. No MongoDB collection, Redis key shape, or JWT/session structure is added or modified. The Redis session store and JWT are *consumed* by the gate exactly as they are today.

For completeness, the transient (in-memory, per-request) constructs introduced are documented below — none are persisted.

## Transient constructs

### GateDecision (in-memory, per request)

The centralized middleware computes a decision and discards it after the request.

| Field | Type | Meaning |
| --- | --- | --- |
| `pathname` | string | Normalized request path (from the request URL). |
| `isPublic` | boolean | True if `pathname` matches the public-route allowlist (gate-exempt). |
| `isAuthenticated` | boolean | True if a valid access token is present (reuses `auth.ts` token validation). |
| `outcome` | `"pass"` \| `"reject-401"` | `reject-401` when `!isPublic && !isAuthenticated`; otherwise `pass`. |

Not stored anywhere; expressed as a return value / early `Response`.

### PublicRouteAllowlist (static configuration)

A static, code-defined list (not data) of gate-exempt BFF route path patterns. Source of truth for `isPublicBffRoute(pathname)`.

| Member | Reason exempt |
| --- | --- |
| `/bff-api/auth/login` | Pre-authentication (establishes the session). |
| `/bff-api/auth/register` | Account creation; no session yet. |
| `/bff-api/auth/verify-email` | Email action-token flow; no access token. |
| `/bff-api/auth/resend-verification` | Pre-verification; no access token. |
| `/bff-api/auth/init` | Bootstrap/config; no session required. |
| `/bff-api/auth/refresh` | **Validates the refresh/session cookie itself**; runs when the access token is expired, so it must not be gated on a valid access token (clarified 2026-06-03). |

All other `/bff-api/*` routes are protected (deny-by-default).

## Logging field additions (no new entity)

US2 adds fields to existing structured log lines (not a data entity): non-401/403 4xx responses gain a `warn` log carrying `action`, `statusCode`, and the existing `requestId`. Subject to the standard redaction list — no token/session-id/PII/raw-id values.

## Validation rules (unchanged)

`validateObjectId` keeps its safe-character whitelist (`/^[A-Za-z0-9_-]+$/`). No new validation entity; the rule is retained verbatim from the prior feature (FR-004).
