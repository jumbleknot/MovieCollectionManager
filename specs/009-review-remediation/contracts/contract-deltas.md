# Phase 1 Contract Deltas: Full-Repo Review Remediation

Behavioral contract changes to **existing** interfaces. No new endpoints. mc-service changes are reflected in `/api-specs` OpenAPI (Specification-First) before implementation; BFF route changes are validated by integration/E2E tests.

---

## BFF API routes (`mcm-app`)

### `GET /bff-api/auth/user` (#9)
- **Before**: `validateSessionTimeout(X-Session-Id)` ran before authentication.
- **After**: returns `401` for unauthenticated requests **before** any session lookup/mutation. Session timeout is validated against the authenticated identity only.
- **Contract**: unauthenticated request ⇒ `401`, **no** session state change. Authenticated request ⇒ unchanged `200` profile behavior.

### `POST /bff-api/auth/logout` (#9)
- **Before**: swallowed auth failure, then terminated the session named by `X-Session-Id` and all the user's SSO sessions.
- **After**: clears auth cookies best-effort regardless, but performs `terminateSession` / Keycloak SSO logout **only** when the request is authenticated and the session belongs to the caller.
- **Contract**: unauthenticated request with a victim session id ⇒ victim sessions untouched. Authenticated self-logout ⇒ unchanged `200` + own session terminated.

### `POST /bff-api/auth/register` (#8)
- **After**: additionally throttled per source (IP-derived) beyond the existing per-email limit.
- **Contract**: many registrations with unique emails from one source ⇒ `429` after the configured threshold. Normal single registration ⇒ unchanged `201`.

### `GET /bff-api/auth/verify-email` (#7)
- **Before**: any `302` from Keycloak ⇒ `{ success: true }`.
- **After**: `{ success: true }` only on a genuine success outcome; invalid/expired/used links ⇒ `400` with the appropriate `VERIFICATION_TOKEN_*` code.
- **Contract**: invalid/expired/used token ⇒ failure response (no false success). Valid token ⇒ `200` success.

### `GET|PATCH|DELETE /bff-api/collections/{collectionId}` and `.../movies/{movieId}`, `.../movies`, `.../movies/filter-options` (#10)
- **After**: `collectionId`/`movieId` validated against a safe path-segment whitelist (`/^[A-Za-z0-9_-]+$/`) before the upstream call — **not** a strict 24-hex ObjectId check (a strict check 400s the Expo-Router-shadowed `…/movies/filter-options` sub-path, which binds `movieId="filter-options"`; see research R6).
- **Contract**: a smuggling identifier (separators, encoded separators, query characters, whitespace, traversal, empty) ⇒ `400` problem response at the edge, **no** upstream call and no opaque `500`. A safe identifier — including well-formed-but-unknown ids and legitimately-shadowed sub-paths — is forwarded; mc-service returns `404` for unknown ids (unchanged behavior).

---

## mc-service API (`/api/v1`) — OpenAPI deltas in `/api-specs`

### `PUT /api/v1/collections/{collectionId}/movies/{movieId}` (#5)
- **Contract**: response `createdAt` equals the movie's original creation time across edits; only `updatedAt` advances.

### `POST` / `PUT` movie (#1, FR-022)
- **Contract**: `400`/problem response when `title` or `language` is empty, when an `externalIds[].url` scheme is not `http(s)`, when an external-id required part is empty, or when duplicate `(system, uniqueId)` pairs are present. Valid payloads unchanged.

### `PATCH /api/v1/collections/{collectionId}` with `isDefault: true` (#6)
- **Contract**: if the target is not owned/does not exist, or any other part of the PATCH fails validation, the caller's existing default is unchanged and the prior error status is returned. Success ⇒ exactly one default for the owner.

### `GET /api/v1/collections/{collectionId}/movies?cursor=…` (FR-019)
- **Contract**: malformed/undecodable `cursor` ⇒ `400` problem response (not a silent page-1 restart). Valid cursor ⇒ unchanged keyset pagination.

---

## Internal contracts (no external surface)

- **Session Redis TTL** (#3): store TTL ≥ remaining absolute lifetime; idle/absolute policy enforced in application logic (verified via real-Redis integration assertions on TTL).
- **Rate-limit identity** (#4): non-spoofable per-client identity; no shared bucket (verified via integration tests rotating the forwarding header).
- **Concurrent-session cap** (FR-018): never exceeds the configured maximum under concurrent logins.
- **`PasswordStrength.score`** (FR-020): `0–4` for all inputs (unit-tested).
- **Cached-session parse safety** (FR-021): corrupt value ⇒ treated as no session.
- **Client URL guard** (#1, FR-003): `movie-detail` opens only `http(s)` URLs.
