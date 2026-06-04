# Phase 0 Research: Clean Expo Router

No blocking unknowns remain after clarification. This records the HOW decision for each user story plus the one cross-cutting justification, with rationale and rejected alternatives. The single genuinely-uncertain item — whether the alpha `+middleware.ts` capability is usable here — is structured as a viability spike (R3) with an explicit descope path.

---

## R1 — Filter-options route shadowing (US1, FR-001–FR-004)

**Decision**: Treat the fix in two parts — *reproduce the mechanism first*, then *guarantee precedence*.

1. **Reproduce (RED)**: add a test that drives `GET /bff-api/collections/{id}/movies/filter-options` and asserts the response is the `FilterOptionsDto` shape produced by `filter-options+api.ts`, not a single-movie result/error. Confirm whether the dynamic `[movieId]` handler is invoked with `movieId="filter-options"`.
2. **Guarantee precedence (GREEN)** — preferred resolution order:
   - **A. Confirm-and-rely on native static-wins precedence.** Expo Router's documented rule is that static segments take precedence over dynamic ones, so the shadowing observed in feature 009 was most likely a stale route-manifest / Metro-cache artifact, not a routing-engine guarantee failure. If a clean rebuild resolves it, the fix is the regression guard (step 1) plus documenting static-wins as the contract.
   - **B. Restructure if A does not hold.** If the static route is genuinely shadowed by `[movieId]`, move filter-options off the shadowed sibling position — e.g. `…/movies/options/index+api.ts` (a static segment that has no dynamic sibling) — and update the BFF client and callers. Less preferred (touches the client contract) but deterministic.
   - **C. Defensive delegation (last resort).** Only if A and B are infeasible: in `[movieId]+api.ts`, detect a known fixed-name sub-path and 404/delegate. Rejected as a primary fix because it re-encodes the trap in handler code.
3. **Keep the whitelist** (`/^[A-Za-z0-9_-]+$/`). It is correct independent of precedence and is what lets a legitimately-shadowed sub-path survive to mc-service (404) rather than 400 at the edge.

**Implementation finding (2026-06-03)**: handler identity is **not black-box observable** and is **moot for correctness** — the dedicated `filter-options` handler and the dynamic `[movieId]` handler both forward to the *identical* upstream path (`/api/v1/collections/{id}/movies/filter-options`), and mc-service (static-wins) returns the same `FilterOptionsDto` either way. The 009 break was solely the BFF-side strict `validateObjectId`, already fixed by the whitelist. Therefore US1 reduces to a **regression guard** (lock in the correct result + no edge 400), not a RED→GREEN cycle and not a structural change. The guard asserts the observable guarantee (FR-002 reworded accordingly).

**Rationale**: A reproduction-first approach avoids "fixing" a cache artifact with a permanent structural change, and the regression guard makes recurrence impossible regardless of which resolution applies.

**Alternatives rejected**: re-tighten `validateObjectId` to strict 24-hex (the original regression — FR-004 forbids it); rely on the whitelist alone with no guard (leaves the door open to silent re-shadowing if the route tree changes).

---

## R2 — 4xx logging at the BFF error boundary (US2, FR-005–FR-009)

**Decision**: In `handleMcApiError`, after the existing 401/403 `audit` branches, add a `warn`-level structured log for any other 4xx (both client-side `AuthError` with `statusCode` in 400–499 and upstream Axios `err.response.status` in 400–499). The entry carries `action`, `statusCode`, and the `requestId` already present via `AsyncLocalStorage`; it relies on the logger's existing redaction (no raw id value, no body, no token/PII). 401/403 keep their `audit` events unchanged; 5xx keeps `logger.error`.

**Rationale**: Safe Error Responses + Logging & Monitoring. The missing log line is what made a deterministic 400 look like flakiness; a `warn` (not `audit`) keeps security events distinct from ordinary client errors while making the whole 4xx class self-explaining.

**Alternatives rejected**: log 4xx as `audit` (pollutes the security stream and inflates 90-day audit retention with non-security events); log at `error` (4xx is a client fault, not an actionable server error — would create alert noise); log the offending id value (risk of leaking sensitive path content — log the action/route instead).

---

## R3 — Centralized access-control gate via `+middleware.ts` (US3, FR-010–FR-019)

**Capability (verified against SDK 56, [Expo Router middleware docs](https://docs.expo.dev/router/web/middleware/))**:

| Aspect | Finding |
| --- | --- |
| Availability | SDK 54+, **alpha** (`unstable_*`). Repo is SDK 56 → available. |
| File | Single `src/app/+middleware.ts`, runs for **all server requests**; scope via `unstable_settings.matcher` (`patterns`, `methods`). |
| Signature | `export default function middleware(request)`; optional `MiddlewareFunction` type from `expo-router/server`. |
| Can | Run **before** handlers; **short-circuit** by returning a `Response`; `Response.redirect()`; read URL/method/headers/cookies. |
| Cannot | Request is **immutable** — cannot mutate headers or inject downstream context. |
| Scope | Server/HTTP only; runs for `+api.ts` calls from **web and native** clients; NOT for in-app `<Link>`/`router` navigation. |
| Enable | `web.output: "server"` (already set) + `["expo-router", { unstable_useServerMiddleware: true }]` in `app.json`. |

**Decision**:

1. **Viability spike first (FR-018)**: enable the flag, add a minimal `+middleware.ts` scoped to `patterns: ['/bff-api/[...path]']`, and confirm in the dev container that (a) it executes for web fetches and native HTTP calls and (b) a returned `Response` short-circuits the handler. If unusable, descope the gate to a follow-up and ship US1+US2 (which do not depend on it).
2. **Gate logic in the BFF-Layer**: `+middleware.ts` is a thin delegator into `src/bff-server/bff-route-access.ts`, which exposes `isPublicBffRoute(pathname)` (the allowlist) and the deny-by-default decision. The gate reuses `auth.ts`'s token extraction/validation to decide authenticated-or-not, and returns a `401` `Response` with `securityHeaders()` for unauthenticated protected requests.
3. **Public allowlist (FR-012)**: `login`, `register`, `verify-email`, `resend-verification`, `init`, **and `refresh`**. Refresh is exempt because it validates the session/refresh cookie itself and runs precisely when the access token is expired; gating it on a valid access token would break the refresh flow (clarified 2026-06-03).
4. **Gate is a guard, not a context provider** (immutability constraint): handlers keep `requireAuth` (to derive the `UserProfile`) and `requireMcUser`/resource checks (FR-014). The gate guarantees deny-by-default; the handlers guarantee identity + authorization.
5. **Safeguard (FR-015)**: a coverage integration test that fails if the gate is disabled or stops matching `/bff-api/*` — protects against an SDK bump silently dropping the `unstable_*` capability.

**Rationale**: Directly satisfies the constitution's Centralized Access Control test (a protected route stays protected with no per-handler auth code). Keeping policy in `bff-server/` keeps it unit-testable and within the BFF-Layer; the thin `+middleware.ts` honors the App-Layer/BFF-Layer separation.

**Alternatives rejected**: keep per-handler `requireAuth` only (the current non-compliant state — a forgotten guard is silently public); push the gate into each route via a shared wrapper (still per-handler opt-in, same failure mode); a custom Node server in front of `@expo/server` (re-platforming, far larger scope than the framework-native middleware); gate token *refresh* (would break the refresh flow — see point 3).

---

## R4 — No API-spec (OpenAPI) change required

**Decision**: This feature changes only BFF Expo Router routes (`src/app/bff-api/**`), the shared BFF error handler, and a BFF middleware. It does **not** alter any mc-service `/api/v1` endpoint, request/response schema, or status contract. The Specification-First principle applies to `/api-specs` (mc-service OpenAPI); there is nothing to update there.

**Rationale**: The BFF is a proxy/aggregation layer; its routes are not described in `/api-specs`. The behavioral contracts that *do* change are captured in `contracts/contract-deltas.md` for this feature.

**Alternatives rejected**: author a new OpenAPI doc for BFF routes (out of scope; the repo does not maintain BFF OpenAPI specs, and inventing one here would be scope creep).

---

## Cross-cutting decisions

- **Test-first (FR-016)**: each story gets a fail-first test — routing guard (US1), 4xx-logging assertion (US2), gate enforcement + coverage safeguard (US3) — before the fix.
- **No regressions (FR-016 / SC-005)**: existing mcm-app unit/integration and web/mobile E2E suites are the regression gate; the dev-container web E2E (~54s/93) is the deterministic baseline (per CLAUDE.md diagnosing-flakiness guidance).
- **Gate verification scope (decided 2026-06-03)**: server-side integration test + web E2E; no new mobile E2E flow (the gate is server-side and client-agnostic).
- **Descope path (decided 2026-06-03)**: if the spike (R3.1) fails, US3 becomes a follow-up; US1 and US2 still ship.
