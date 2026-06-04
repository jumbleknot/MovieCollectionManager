# Contract Deltas: Clean Expo Router

This feature changes **BFF behavioral contracts only** — no mc-service `/api/v1` OpenAPI change (see research R4). The three contracts below are the testable surfaces.

---

## 1. Filter-options routing (US1)

### `GET /bff-api/collections/{collectionId}/movies/filter-options`

- **Before**: the request could be matched by the dynamic `[movieId]+api.ts` handler (binding `movieId="filter-options"`), shadowing the dedicated `filter-options+api.ts` handler.
- **After**: the request is always served by the dedicated `filter-options+api.ts` handler and returns the `FilterOptionsDto` (`{ genres, contentTypes, rated, languages, decades, ownedMedia, ripQuality }`).
- **Contract**:
  - A filter-options request is handled by the filter-options handler, never by the single-movie handler. An automated guard fails if the single-movie handler is invoked for this path.
  - A fixed-name sub-route placed alongside the dynamic `[movieId]` route resolves to the fixed-name handler (general precedence guarantee).
  - A genuinely malformed/smuggling identifier still yields a `400` at the edge before any upstream call (the safe-character whitelist is retained; not reverted to strict 24-hex).

---

## 2. Error-boundary logging (US2)

### `handleMcApiError(err, action)` — all BFF collection/movie proxy routes

- **Before**: emits a log only for `401` (`audit: auth_failed`) and `403` (`audit: access_denied`). Any other 4xx returns a response with **no log line**.
- **After**: every 4xx the boundary returns produces a log entry.
- **Contract**:
  - A non-401/403 4xx (e.g. a `400` from `validateObjectId`, or an upstream 404/409) emits exactly one `warn` structured log with `action`, `statusCode`, and `requestId`.
  - `401`/`403` continue to emit their existing `audit` events — no duplication, no downgrade to `warn`.
  - `5xx` logging is unchanged (`logger.error`).
  - No log entry contains tokens, session ids, raw identifier values, or PII (existing redaction applies).

---

## 3. Centralized access-control gate (US3)

### `src/app/+middleware.ts` — applies to `/bff-api/[...path]`

- **Before**: no centralized pre-route gate; protection is per-handler `requireAuth` (constitution-non-compliant — a handler without the call is silently public).
- **After**: a single middleware evaluates every protected `/bff-api/*` request before its handler runs.
- **Contract**:
  - **Unauthenticated + protected route** → middleware returns `401` with `securityHeaders()`; the route handler does **not** execute.
  - **Unauthenticated + public route** (`login`, `register`, `verify-email`, `resend-verification`, `init`, `refresh`) → request passes through and is processed normally.
  - **Authenticated + protected route** → request passes the gate; per-handler `requireMcUser` / resource-ownership checks still apply (gate augments, does not replace).
  - **Token refresh** is never blocked by the gate even when the access token is expired (it self-validates the refresh/session cookie).
  - **Client-agnostic**: the same gate applies to web and native HTTP API calls; it does not apply to in-app client navigation (no HTTP request).
  - **Safeguard**: an automated test fails if the gate is disabled or stops covering `/bff-api/*`.

### Verification (decided 2026-06-03)

- Server-side BFF integration test: unauthenticated protected request → `401`, handler not executed; public request → passes.
- Coverage safeguard integration test: gate matches all protected `/bff-api/*`.
- Existing web E2E suite is the end-to-end regression gate. No new mobile E2E flow (gate is server-side, client-agnostic).
