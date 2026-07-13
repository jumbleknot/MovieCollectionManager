# PRD: Clean Expo Router — Route Shadowing, BFF Error Logging & Centralized Middleware

**Status**: Issues 1 & 2 implemented in feature `010-clean-expo-router`. **Issue 3 (centralized middleware) BLOCKED → follow-up** (see status note below).
**Author**: review follow-up (debugging artifacts from feature `009-review-remediation`)

> **Issue 3 status (2026-06-03, feature 010 implementation):** BLOCKED on the runtime. `expo export` (SDK 56) honors `unstable_useServerMiddleware` and emits `+middleware.js` + a `middleware` entry in `routes.json`, but the pinned **`@expo/server@0.5.3`** runtime adapter does **not** invoke general `+middleware` (express adapter and core `createRequestHandler` ignore it; only `middleware/rsc` exists). A live probe confirmed the gate never runs (unauthenticated request returned the handler's 401, not the gate's). Feature 010 descoped Issue 3 and shipped Issues 1 & 2. **Re-attempt options for the follow-up:** (a) bump `@expo/server` to a version that invokes `+middleware` once SDK-compatible; or (b) implement the gate as an Express middleware in `frontend/mcm-app/server.js` wrapping `createRequestHandler` (covers the deployed container BFF; does NOT cover Metro dev — a known dev-only gap). Either path reuses the `isPublicBffRoute`/`evaluateBffGate` policy designed in 010 (reverted, recoverable from git history / `specs/010-clean-expo-router/`).
**Related**: [research.md R6](../specs/009-review-remediation/research.md), [research.md R2](../specs/009-review-remediation/research.md), [CLAUDE.md §Diagnosing E2E flakiness](../CLAUDE.md), [Expo Router middleware docs](https://docs.expo.dev/router/web/middleware/)
**Stack assumption**: `expo ^56.0.8`, `expo-router ~56.2.8`, `app.json` already sets `web.output: "server"`.

## Problem

Feature `009` surfaced three related Expo-Router / BFF-boundary issues. Two are latent traps left behind by a workaround; the third is an outdated architectural assumption that is now actionable.

1. **Static route `filter-options` is shadowed by the dynamic `[movieId]` route.** A `GET /collections/{id}/movies/filter-options` request is handled by `[movieId]+api.ts` with `movieId="filter-options"` instead of the dedicated [filter-options+api.ts](../frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/filter-options+api.ts) handler. During `009` this collided with a strict `validateObjectId`, produced a silent `400`, broke the movies filter chips, and was repeatedly misdiagnosed as E2E flakiness.

2. **`handleMcApiError` only logs `401`/`403`.** Every other 4xx — notably the `400` above — falls through the shared BFF error handler with **no log line at all** ([mc-api-error.ts](../frontend/mcm-app/src/bff-server/mc-api-error.ts)). A deterministic hard failure was therefore invisible at the boundary and looked like environmental noise.

3. **The "Expo Router exposes no global pre-route hook" assumption is now false.** `009`'s R2 rejected centralized BFF auth middleware on the grounds that "Expo Router exposes no global pre-route hook; the app's established pattern is per-handler `requireAuth`." Expo Router (SDK 54+) now ships **server middleware** via a `+middleware.ts` file that runs before all server route handlers. This reopens the door to the constitution's **Centralized Access Control** principle for the BFF.

## Goals

1. Make `filter-options` (and any future static sibling under `[movieId]`) resolve to its dedicated handler, deterministically, with a regression test — so the `validateObjectId` whitelist is a *defense*, not a *load-bearing workaround*.
2. Make the BFF error boundary observable: log all 4xx (not just 401/403) so a future "mystery 400" is diagnosable in seconds.
3. Evaluate and (if viable) introduce a `+middleware.ts` centralized pre-route hook for the BFF, retiring the outdated R2 assumption and reducing the per-handler `requireAuth` duplication that is a standing tension with the constitution.

## Non-Goals

- Re-tightening `validateObjectId` to a strict 24-hex ObjectId format. The safe-character whitelist (`/^[A-Za-z0-9_-]+$/`) stays — it is correct regardless of how shadowing is resolved.
- Removing per-handler `requireMcUser` / resource authorization (middleware augments, it does not replace resource-level checks).
- Any change to mc-service (its auth is already a centralized Tower layer and is compliant).
- Client-side navigation behavior (`<Link/>`, `router`) — middleware does not run there and that is fine.

---

## Issue 1 — Static/dynamic route shadowing (`filter-options` ↔ `[movieId]`)

### Observed behavior

Under `collections/[collectionId]/movies/` two sibling API routes exist:

| File | Intended match |
| --- | --- |
| `[movieId]+api.ts` | `GET/PUT/DELETE /movies/{ObjectId}` |
| `filter-options+api.ts` | `GET /movies/filter-options` |

During `009`, `GET …/movies/filter-options` reached the `[movieId]` handler bound as `movieId="filter-options"`. The dedicated `filter-options` handler was shadowed. Expo Router's documented precedence is **static segments win over dynamic segments**, so this is either (a) a route-resolution defect/quirk in the API-route matcher, (b) a build/bundling artifact (stale route manifest, Metro cache), or (c) an artifact of how the dev vs container server registers `+api.ts` routes. **The mechanism must be confirmed, not assumed.**

### Proposal

1. **Reproduce and pin the mechanism** (test-first): an integration/E2E assertion that `GET …/movies/filter-options` returns the `FilterOptionsDto` shape from the dedicated handler — and that the `[movieId]` handler is *not* invoked for that path. This is the RED that proves the shadowing before any fix.
2. **Fix route precedence** so the static route wins. Options, in order of preference:
   - **A. Confirm-and-rely on native precedence** — if the shadowing was a stale-manifest/cache artifact, the fix is a clean rebuild + a guard test; document that static-wins is the contract.
   - **B. Restructure the route tree** so `filter-options` is not a sibling of `[movieId]` — e.g. move it to `…/movies/options/index+api.ts` (a static segment with no dynamic sibling) or a non-shadowable path, and update the BFF client + callers.
   - **C. Defensive guard in `[movieId]+api.ts`** — if the id is a known static sub-path, delegate/`404` explicitly. This is the *least* preferred (it re-encodes the trap in code) and only acceptable as a belt-and-suspenders alongside A or B.
3. **Keep the whitelist.** Whatever the resolution, `validateObjectId` stays a permissive safe-char check; the regression test from step 1 guarantees we never silently re-shadow.

### Acceptance criteria

- `GET …/movies/filter-options` is served by the dedicated handler and returns `FilterOptionsDto`; a test fails if it is ever routed through `[movieId]`.
- Adding a new static sibling under `[movieId]` later is covered by (or trivially extends) the precedence test.
- The movies filter-chips E2E path is green on both Metro and the dev container.

---

## Issue 2 — `handleMcApiError` logs only 401/403

### Observed behavior

[mc-api-error.ts:22-55](../frontend/mcm-app/src/bff-server/mc-api-error.ts#L22-L55):

- `AuthError` → `logger.audit` **only** when `statusCode === 401` or `403`.
- Upstream Axios error → `logger.audit` **only** for `401`/`403`.
- Unexpected error → `logger.error` (500).

A `400` (e.g. from `validateObjectId`) is an `AuthError` with `statusCode === 400` → it skips both audit branches, returns a structured 400, and emits **no log**. This is exactly what hid the `009` root cause.

### Proposal

Add structured logging for **all 4xx** at the BFF error boundary:

- For client-side `AuthError` and upstream Axios 4xx that are **not** 401/403, emit `logger.warn` (not `audit`) with `{ action, statusCode, code, route/path, requestId }`.
- Preserve existing `logger.audit('auth_failed'|'access_denied')` for 401/403 (security events) unchanged.
- Honor the no-sensitive-data rules — log the **status, action, code, and request path**, never tokens, bodies, PII, or the raw id value if it could carry sensitive content (the path/action is sufficient for diagnosis).
- 5xx logging via `logger.error` stays as-is.

### Acceptance criteria

- A `validateObjectId` `400` (and any other non-401/403 4xx) produces exactly one `warn`-level structured log entry with `action` and `statusCode`.
- 401/403 still produce their existing `audit` entries (no duplicate/downgraded logging for security events).
- No secret/PII/token is added to any log line (verified against the logger redaction list).

---

## Issue 3 / Task — Centralized BFF middleware via `+middleware.ts` (retire the R2 assumption)

### Research summary (Expo Router server middleware)

Confirmed from the [official docs](https://docs.expo.dev/router/web/middleware/) against this repo's SDK 56:

| Aspect | Finding |
| --- | --- |
| **Availability** | SDK **54+**; status is **alpha/unstable**. Repo is on SDK 56 → available. |
| **File** | A single `src/app/+middleware.ts` that runs for **all server requests** (it is global, not per-route). |
| **Signature** | `export default function middleware(request) { … }` — optionally typed via `MiddlewareFunction` from `expo-router/server`. |
| **Capabilities** | Runs **before any route handler**; can **short-circuit** by returning a `Response`; can **redirect** via `Response.redirect()`; can **read** URL/method/headers/params/query. |
| **Hard limitation** | The request is **immutable** — middleware **cannot modify headers or consume the request body**, so it **cannot inject** a derived user/context object downstream into the route handler. |
| **Scope** | **Server-side, web/HTTP only.** Does **not** run for client-side `<Link/>`/`router` navigation or native screen transitions. **Does** run for API-route (`+api.ts`) calls from **any** client — including the native app's HTTP calls to the BFF. |
| **Matcher** | `export const unstable_settings = { matcher: { methods: ['GET'], patterns: ['/bff-api/[...path]'] } }` — patterns support exact paths, `[id]`, `[...slug]`, and regex; method+pattern are AND'd. |
| **Enable flag** | `app.json` → `web.output: "server"` (already set) **plus** the plugin flag `["expo-router", { "unstable_useServerMiddleware": true }]`. Production needs a deployed server (we already run the BFF container). |

**Conclusion:** the `009` R2 claim — "Expo Router exposes no global pre-route hook" — is **outdated**. A global pre-route hook now exists and covers exactly the surface that matters for the BFF (HTTP requests to `+api.ts` from web and native clients).

### What middleware can and cannot do for us (be honest about the limits)

- ✅ **Centralized rejection / deny-by-default**: read the session cookie / auth header, and `return` a `401`/`403` `Response` for unauthenticated requests to `/bff-api/*` **before** any handler runs — a true centralized access-control gate (constitution alignment).
- ✅ **Centralized cross-cutting policy**: uniform security headers on rejections, request-id stamping at the edge (via response, not request mutation), method/path allowlisting.
- ❌ **Cannot replace `requireAuth`'s downstream contract**: because the request is immutable, middleware cannot attach the validated `user`/`UserProfile` for the handler to consume. Handlers that need the user object still call `requireAuth`/`extractRawToken`. Middleware is a **gate**, not a context provider.
- ❌ **Does not do resource-level authorization**: `requireMcUser` and per-resource checks (and the future DAC checks in `docs/PRD-CleanDAC.md`) remain in handlers / mc-service.
- ⚠️ **Alpha API**: `unstable_*` naming signals churn; pin the SDK and add a smoke test so an SDK bump can't silently disable the gate.

### Proposal

1. **Spike (timeboxed):** enable `unstable_useServerMiddleware`, add `src/app/+middleware.ts` scoped via `unstable_settings.matcher` to `patterns: ['/bff-api/[...path]']`, and verify it executes for (a) web fetches and (b) the native app's HTTP calls in the dev container. Confirm a returned `Response` short-circuits the handler.
2. **Implement a deny-by-default auth gate** in `+middleware.ts`: for `/bff-api/*` except the documented public auth routes (`login`, `register`, `verify-email`, `resend-verification`, `init`, `refresh` as applicable), reject unauthenticated requests with a typed `401` `Response` carrying `securityHeaders()`. Keep the per-handler `requireAuth` for user-object derivation (defense-in-depth + context).
3. **Move uniform edge concerns into the gate** where they don't need request mutation: security headers on early rejections, request-id correlation seeding, method allowlisting.
4. **Smoke test the gate** (so an SDK upgrade can't silently disable it): an integration test asserting an unauthenticated `/bff-api/collections` call is rejected at the middleware (handler never invoked).
5. **Update the architecture record:** amend `009` R2 / the Centralized Access Control note in `CLAUDE.md` and the constitution tension memo to reflect that the BFF now *can* (and does) centralize the auth gate, with the immutability caveat documented.

### Acceptance criteria

- `src/app/+middleware.ts` runs before route handlers for `/bff-api/*` on both web and native HTTP calls (verified in the dev container).
- An unauthenticated request to a protected `/bff-api/*` route is rejected by the middleware with a `401` and `securityHeaders()`, and the route handler is **not** executed.
- Public auth routes remain reachable unauthenticated.
- Per-handler `requireMcUser` and resource authorization are unchanged; user-object–dependent handlers still derive the user via `requireAuth`.
- A guard test fails if middleware is disabled or stops matching `/bff-api/*` (SDK-bump safety).
- `CLAUDE.md` / constitution note updated to retire the "no global pre-route hook" assumption.

---

## Sequencing & Relationship to other work

- Issues 1 and 2 are small, independent hardening items and can ship together as a fast follow-up to `009`.
- Issue 3 is a larger architectural change (alpha API, app.json/plugin change, new gate + tests) — best run through the SDD flow as its own slice: `/speckit-specify docs\PRD-CleanExpoRouter.md`, or split Issue 3 into a dedicated "Centralized BFF Access Control" feature and keep 1+2 as a quick remediation.
- Issue 3 partially relieves the standing tension recorded in `project_bff_centralized_auth_followup` (BFF lacked centralized access control). It does **not** replace mc-service's enforcement or the DAC work in `docs/PRD-CleanDAC.md`.

## Constitution Alignment

- **Centralized Access Control**: Issue 3 introduces a single pre-route gate for the BFF, the long-missing counterpart to mc-service's Tower auth layer.
- **Deny by default / Least privilege**: the gate rejects unauthenticated `/bff-api/*` by default; handlers keep least-privilege resource checks.
- **Observability / Safe Error Responses**: Issue 2 makes the error boundary observable without leaking internals; Issue 1's guard test keeps a security-relevant validator from silently misfiring.
- **Test-First**: every change is RED→GREEN (precedence test, 4xx-logging test, middleware smoke/guard test).
