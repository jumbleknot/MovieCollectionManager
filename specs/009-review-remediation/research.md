# Phase 0 Research: Full-Repo Review Remediation

No blocking unknowns — the stack is fixed by the constitution and CLAUDE.md, and the spec is clarified. Research here records the **HOW decision** for each finding (and the two clarified ambiguities), with rationale and rejected alternatives. Items flagged *(confirm in test)* are validated against real dependencies during implementation, not assumed.

---

## R1 — External-ID URL scheme allowlist (#1, US1)

**Decision**: Enforce an `http`/`https` scheme allowlist in **two** places (defense in depth):
1. **mc-service Domain-Layer** — a `HttpUrlSpec` Specification validates each `ExternalIdentifier.url`; the create/update **Application-Layer** handlers run it (today serde `Deserialize` bypasses `ExternalIdentifier::new`, so validation must be invoked explicitly on the wire path, alongside the existing non-empty/duplicate checks that are also currently skipped).
2. **BFF client** — `movie-detail.tsx` `openUrl` refuses any non-`http(s)` URL before `window.open`/`Linking.openURL`, protecting pre-existing stored data.

**Rationale**: Constitution Input Validation (server-side whitelist) is the source of truth; Output Encoding/XSS plus the client guard cover already-persisted rows and native deep-link abuse.

**Alternatives rejected**: client-only (server remains the authority and other clients could be added); silently stripping the bad URL (worse observability than an explicit validation error).

---

## R2 — Session-affecting endpoint auth ordering (#9, US2)

**Decision**: In `user+api.ts`, run `requireAuth` (+ `requireMcUser`) **before** `validateSessionTimeout`, and validate the session derived from the authenticated identity, not a raw `X-Session-Id` header. In `logout+api.ts`, keep cookie-clearing best-effort, but perform server session + Keycloak SSO termination **only** when the request is authenticated and the target session belongs to the authenticated user; an unauthenticated request clears cookies only and triggers no `terminateSession`/`logoutUserSessions` for an arbitrary header-supplied id.

**Rationale**: Deny-by-default — no unauthenticated session side effects (FR-004/005). Logout still works for legitimate users (FR-006).

**Alternatives rejected**: full centralized BFF middleware (Expo Router exposes no global pre-route hook; the app's established pattern is per-handler `requireAuth` inside `withRequestContext` — a framework-level middleware is a larger, out-of-scope refactor). mc-service already uses the compliant Tower-layer model.

---

## R3 — Rate-limit client identity (#4, US3)

**Decision**: Replace `extractClientIp`'s "trust any `X-Forwarded-For`, else `'unknown'`" with a precedence:
1. If a **trusted proxy** is configured (e.g., `TRUSTED_PROXY` enabled, as in the prod Caddy deployment) and the immediate peer is the proxy, use the left-most `X-Forwarded-For` entry.
2. Otherwise use the **connection's remote address** surfaced by the server adapter.
3. The shared `'unknown'` sentinel is eliminated — clients are never collapsed into one bucket (FR-008).

*(confirm in test)* How the peer/remote address is obtained in the `@expo/server` Node runtime: in prod it is the Caddy-set trusted header (e.g., `X-Real-IP`/left-most XFF); in local/dev (no proxy) it is the loopback/connection address exposed by the Node adapter. A task spike confirms the exact plumbing before the fix lands; the **behavior** (non-spoofable identity, no global lockout) is fixed regardless.

**Rationale**: Constitution Rate Limiting (per IP); standard trusted-proxy pattern prevents both header-spoofing bypass and absent-header global lockout.

**Alternatives rejected**: trust XFF unconditionally (spoofable — the bug); fall back to a shared bucket (global DoS — the other half of the bug); fail-open when no IP (the clarification chose trusted-proxy + connection IP, not fail-open).

---

## R4 — Session Redis TTL vs configured timeouts (#3, US4)

**Decision**: Set the session key's Redis TTL to the **remaining absolute lifetime** (`expiresAt - now`, in seconds), refreshed on each activity touch, instead of a fixed 600 s. Idle and absolute expiry remain enforced in `getValidSession` application logic (the authority), which already deletes and returns `null` on breach — so behavior stays fail-safe. The independent profile cache TTL (300 s) is unchanged.

**Rationale**: The store TTL must be a **backstop ≥ policy**, never shorter, or it silently overrides the configured idle/absolute windows (FR-010/011). Application logic keeps enforcing the real policy and fails safe (FR-012).

**Alternatives rejected**: TTL = idle window (would cut the absolute lifetime short for active users on the edge, and re-introduces a hidden cap); removing the TTL entirely (loses the orphan-key backstop).

---

## R5 — verify-email true outcome (#7, US5)

**Decision**: With `redirect: 'manual'`, inspect the 302 **Location** to distinguish a genuine success redirect (the configured success/info target, no error indicator) from Keycloak's error-page redirect (error path / `error` parameter), and report success **only** on the genuine-success case; treat error/expired/used redirects (and non-2xx/302) as failure. *(confirm in test)* against real Keycloak: capture the actual success vs invalid/expired/used redirect targets and assert the mapping in an integration test; if the redirect is ambiguous, cross-check the user's `emailVerified` via the service-account Admin API as the authoritative signal.

**Rationale**: Accurate status (FR-016); today any 302 is treated as success, which is the defect.

**Alternatives rejected**: keep `status === 302 ⇒ success` (the bug); remove the endpoint (clarification chose "report true outcome accurately", and the route still backs the app's deep-link verified-state handling).

---

## R6 — Resource-identifier validation at the BFF boundary (#10, US5)

**Decision**: Add a small shared validator that asserts `collectionId`/`movieId` match the MongoDB ObjectId format (24 lowercase hex) before they are interpolated into the upstream URL, and `encodeURIComponent` them when building the path. Malformed ids return a clean `400` via the existing `handleMcApiError`/problem-response convention, before any upstream call. Applied uniformly across every parameterized collections/movies route.

**Rationale**: Input Validation whitelist + Safe Error Responses; prevents path/param smuggling and opaque upstream 500s (FR-017).

**Alternatives rejected**: per-route ad-hoc checks (drift risk — one route validates, a sibling doesn't); relying on mc-service to reject (still smuggling-exposed and yields opaque errors at the edge).

---

## R7 — Set-default atomicity (#6, US5)

**Decision**: In `set_default_collection.handle`, **validate the target exists and is owned by the caller before** clearing the current default; perform clear+set inside a MongoDB transaction (mirroring the existing transactional cascade-delete in `collection_repository.delete`), rolling back on any failure. In `update_collection`/`update.rs`, validate the rest of the PATCH (e.g., name) and run the set-default + update so that a later validation failure cannot leave a switched default — all-or-nothing (FR-014/015).

**Rationale**: Reuses the established replica-set transaction pattern; eliminates the "old default cleared, new set failed → no default" and "default switched on a failed PATCH" states.

**Alternatives rejected**: keep clear-then-set without pre-validation (the bug); validation-order-only without a transaction (narrows but doesn't close the crash-between-writes window — the transaction is already available and idiomatic here).

---

## R8 — Preserve createdAt on movie update (#5, US5)

**Decision**: Stop overwriting `createdAt` in `movie_repository.update`. Prefer a targeted `update_one` with `$set` on the mutable fields and `updatedAt = now`, leaving `createdAt` untouched (avoids the read-modify-write round-trip and race of fetch-then-replace). If `replace_one` is retained for simplicity, first read the existing document and carry its original `created_at` into the replacement.

**Rationale**: Data integrity (FR-013); the current code's own comment admits the overwrite is wrong. `$set` is the least-surprise, race-free fix.

**Alternatives rejected**: fetch-then-replace (extra round-trip + lost-update race under concurrency); client-supplied createdAt (untrusted, spoofable).

---

## R9 — Lower-severity hardening batch (US6)

- **Concurrent-session eviction TOCTOU (FR-018)**: after creating the new session, atomically trim the user's session set down to the configured max (re-check count and evict oldest while over the cap), or use a Redis Lua script for the count-evict-add sequence. Decision: evict-to-cap loop with a final re-check; escalate to Lua only if a race remains under the integration test. **Rationale**: SCARD-then-evict-then-SADD is not atomic; concurrent logins overshoot the cap today.
- **Malformed pagination cursor (FR-019)**: `decode_cursor` returns a typed error; `movies/list` maps a bad cursor to a `400` problem response instead of silently dropping the filter and restarting at page 1. **Rationale**: silent restart is a correctness defect; an explicit 400 is the contract.
- **Password score range (FR-020)**: return the already-computed clamped `score` (0–4) from `evaluatePassword`, not the raw `passed` count (0–5). One-line fix; add a test for the all-criteria-met case. **Rationale**: honor the documented `PasswordStrength.score` contract.
- **Corrupt cached session (FR-021)**: wrap `JSON.parse` in `getSession`/`updateSessionActivity`/`getCachedUserProfile` in try/catch; on parse failure treat as missing (return `null`) and delete the corrupt key. **Rationale**: a corrupt value must degrade to "no session" (fail-safe), not an unhandled 500.
- **Required movie fields (FR-022)**: add a `RequiredStringSpec` (Domain) and enforce non-empty `title`/`language` in `create_movie`/`update_movie`. **Rationale**: the domain marks these required, but no spec enforced it.

---

## Cross-cutting decisions

- **Test-first (FR-023)**: every finding gets a fail-first test (unit/integration/E2E as appropriate) demonstrating the pre-fix defect, then the fix turns it green. tasks.md uses the Verify RED / Verify GREEN checkpoint format.
- **No regressions (FR-024)**: the existing mcm-app unit/integration, web + mobile E2E, and mc-service unit/integration suites are the regression gate.
- **Specification-First**: mc-service behavioral changes (createdAt immutability, set-default atomicity, cursor 400, external-id/required-field validation) update `/api-specs` OpenAPI before code.
- **Out of scope**: #2 (IDOR / owner-scoped uniqueness) per clarification; the refuted JWT algorithm-allowlist item is optional defense-in-depth, not planned here.
