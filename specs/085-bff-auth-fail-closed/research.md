# Research: BFF Auth Fail-Closed Hardening (085)

Each decision below was taken against `main` at `ebf11f23` (2026-11-01). Paths are relative to
`frontend/mcm-app/` unless stated.

## R1 — One authenticator: `requireAuth(headers)` becomes session-based

**Decision.** `requireAuth(headers)` keeps its name and its place at the top of every handler, and
becomes the only way a request authenticates:

1. It reads `mcm_session_id` from the **cookie** (never a header).
2. It loads the session record, enforcing absolute expiry, then idle expiry. Each has its own error
   code and audit reason (FR-012, FR-023).
3. It decrypts the session's tokens and renews them under the session's renewal lock if the access
   token expires within the skew (R4).
4. It validates the JWT exactly as today (`validateJwt`), then touches the session (R3).

It returns `{ payload, user, accessToken, session }`. `extractRawToken(headers)` is deleted, and its
~20 call sites take `accessToken` from the `requireAuth` result instead.

**Rationale.**
- The SAST rule `mcm-auth-before-authz` matches a `requireAuth(…)` call textually before
  `createMcServiceClient(…)`. Keeping the name keeps that guard meaningful, without an allowlist entry.
- Folding the session read, the token read and the idle check into one call is what makes FR-023
  free (spec Assumptions: idle-timeout reach).
- Deleting `extractRawToken` removes the only way left to read a credential from request headers. A
  future handler cannot reintroduce bearer acceptance (US3) by calling an old helper.

**Alternatives rejected.**
- *A route-level middleware in `server.js`.* Expo Router API routes have no shared middleware chain
  in this build; every route already calls `requireAuth`. Moving the call site is a separate
  refactor, and would also invalidate the SAST rule's structural match.
- *Keep `extractRawToken`, reading from the session.* It would have to become async and
  re-read Redis, a second round trip per request, for no gain.

## R2 — Bearer acceptance is removed, not gated (FR-008, FR-009)

**Decision.** `extractToken`'s `Authorization: Bearer` branch is deleted with the function. There
is no environment flag. A request with only a bearer gets `401 UNAUTHORIZED` (`no_session`), and a
request with both gets authenticated by the cookie. The bearer is not even read.

**Rationale.** The operator chose FR-009 option B on 2026-11-01. A flag would be a parallel
authentication path created for testing, which the constitution names as prohibited (§Security
→ Prohibited Patterns).

**Harness migration (FR-009).** Two counts from the spec need correcting:
- The 27 integration files that send a bearer to the BFF are **25** today (`grep -lE "Authorization:
  \`Bearer" tests/integration/*.test.ts`).
- **No** E2E file sends a bearer to the BFF. `tests/e2e/web/setup/keycloak-admin.ts` sends one to
  the Keycloak **Admin API**, which is not the server under test, and that stays. The E2E files this
  feature does change are the two that read the token **cookies**: `bff-prod-lifecycle.spec.ts` and
  `agent-session-refresh.spec.ts`, which US6 rewrites.
- The DAST login (`scripts/dast-bff-login.mjs`, `scripts/zap-scan.mjs`,
  `security/zap/scripts/bff-session-refresh.js`) is also cookie-dependent and moves with US6.

**The harness login.** A new helper, `tests/integration/helpers/bff-session.ts`, establishes a
session the way a member's is established:
1. `GET /bff-api/auth/init`, which registers `${BFF}/auth-callback` on the login client.
2. Walk Keycloak's authorization-code + PKCE flow in Node. This generalises
   `keycloak-browser-flow.ts`'s `walkStepUpLogin`, which already handles the cookie traps it
   documents.
3. `POST /bff-api/auth/login` with `{code, codeVerifier, redirectUri}`.
4. Return the `Cookie:` header from the `Set-Cookie` response, which is only `mcm_session_id` after US6.

Rate limits: the login limit is per **trusted client IP**. The integration BFF runs with
`TRUSTED_PROXY` unset, so `extractClientIp` returns `null` and `enforceIpLimit` skips. This is
measured in `rate-limiter.ts`, not assumed. If CI sets `TRUSTED_PROXY=true` for the integration
BFF, the helper sends a distinct `X-Forwarded-For` per user; a task verifies which applies.
Concurrent-session cap: each file creates its own users, and a user logs in once per file, so
the per-user cap of 10 is never reached.

**ROPC tokens remain** for what is not "authenticating to the BFF":
- `agent-subject-token.integration.test.ts` mints from a real access token against Keycloak.
- The audience-mapper setup.

## R3 — Server-held tokens: storage shape (FR-016, FR-017, FR-020)

**Decision.** The tokens live in a **separate Redis key** from the session record:

| Key | Value | TTL |
|---|---|---|
| `session:{sid}` | the existing `Session` JSON: owner, created, last activity, absolute expiry (unchanged shape) | remaining absolute lifetime (unchanged) |
| `session-tokens:{sid}` | `{ v: 1, accessExpiresAt, refreshExpiresAt, blob }`, where `blob` = AES-256-GCM of `{accessToken, refreshToken}` and the expiry times are in clear, outside the AAD (data-model.md, analysis U2) | the same remaining absolute lifetime |

- **AAD** = `${sid}:${userId}:sessionTokens`. A blob moved to another session or another user
  fails authentication, as `secretAad` does for agent config.
- **Touch** writes only the session record, with `SET … XX` (update if present). Renewal writes
  only the tokens key. Delete removes both.

**Rationale.**
- *Why two keys.* `touchSession` today is read-modify-write of the whole record. With tokens inside
  that record, request A could read the old tokens, request B could renew and rotate the refresh
  token, and then A's touch would write the **old** tokens back. Under refresh-token rotation that
  revokes the session on the next renewal. Two keys mean touch never writes tokens.
- *Why `XX`.* Without it, a touch racing a logout re-creates the session record after the delete.
  That fails closed today (no tokens key, so 401), but it leaves a zombie record counting against
  the concurrent-session cap until its TTL runs out.

**Key.** The blob is sealed with the existing `encryptSecret`/`decryptSecret` primitives under
**`AGENT_CONFIG_ENC_KEY`**, as the operator directed ("the existing agent-config crypto
mechanism"). It is required in production (`compose.prod.yaml` uses `:?`, and it is a Komodo
Variable in `stacks.toml`), it is provisioned in CI (`app-ci.yml`), and `gen-dev-env.mjs` mints it
for dev. So this adds **no operator step** before deploy.

- **Trade-off, recorded:** feature 073 chose a separate key for backup credentials to bound blast
  radius. With a shared key, a leak of `AGENT_CONFIG_ENC_KEY` plus a Redis dump now yields live
  session tokens as well as assistant API keys. The AAD stops cross-context reuse; it does not stop
  a holder of the key.
- **Follow-up:** a dedicated `SESSION_TOKEN_ENC_KEY` is a one-line change at the call site, plus a
  Komodo Variable. It is filed as a backlog follow-up, not done here, because it needs an operator
  step before deploy.

**Login without the key.** `loadKey` throws if the key is absent. Login then fails closed with
`503`, which is the intended behaviour: there is no unencrypted fallback (FR-017).

## R4 — Server-side renewal, at most once (FR-018, FR-019)

**Decision.** `ensureFreshTokens(session, tokens)` in a new `session-tokens.ts`:
- If `accessExpiresAt - now > 30 s`, it returns the tokens as they are.
- Otherwise it takes `setLockIfAbsent('session-renew:{sid}', holder, 15 s)`.
  - **Winner:** calls Keycloak `refresh_token`, checks that the new token's `sub` equals
    `session.userId` (shared with FR-006), writes the tokens key, and releases with
    `releaseLockIfHeld`.
  - **Loser:** polls the tokens key every 100 ms for up to 5 s, until `accessExpiresAt` advances,
    then uses those tokens. On timeout it returns `503 SESSION_RENEWAL_PENDING` (retryable).
- `refreshTokens` (keycloak.ts) is split by cause:
  - **Rejected:** `400`/`401` from the token endpoint (`invalid_grant`: revoked, expired, or
    session not active). The session and its tokens are deleted, the audit event is
    `session_renewal_rejected`, and the request gets `401 REFRESH_FAILED`. The client then goes to
    sign-in.
  - **Transient:** network error, timeout (`AbortSignal.timeout(5000)`) or `5xx`. The session is
    **kept** and the request gets `503 KEYCLOAK_UNAVAILABLE`.

**Rationale.**
- *30 s skew* covers clock drift plus the mc-service round trip. Keycloak's access lifespan here is
  about 5 min.
- *Lock TTL 15 s* is above Keycloak's 5 s timeout plus write time.
- The loser does not renew itself: Keycloak rotates refresh tokens, so a second use of the same
  refresh token is refused, which would end the member's session. That is the Acceptance
  Scenario 5 failure.
- `withLeaderLock` from `redis-lock.ts` is not used as it stands, because the loser has to *wait
  for the result* rather than skip. The underlying `setLockIfAbsent` / `releaseLockIfHeld` are
  reused, with their holder-checked release.

## R5 — Client renewal path against the new model (FR-021, FR-006, FR-007)

**Decision.** `POST /bff-api/auth/refresh` keeps its URL, rate limit and response body
(`{success, expiresIn}`), so `token-refresh.ts` and `agent-fetch-refresh.ts` need **no change**.
It now:
1. Resolves the caller's own session from the cookie. No session reference is ever taken from the
   body or a header.
2. Forces a renewal through the R4 path (lock included), whatever the remaining lifetime.
3. Sets **no** token cookie; it re-sets only `mcm_session_id`, with the same Max-Age.

The ownership check (FR-006) is the `sub` comparison inside R4's renewal, so it applies to
server-side and client-initiated renewal alike. On a mismatch (FR-007):
- the tokens are not written and the session is not touched;
- the session is deleted, because a refresh token that resolves to someone else means the record
  is corrupt or tampered;
- `401 SESSION_OWNER_MISMATCH` is returned, with no `Set-Cookie` except clearing;
- `audit('session_refresh_owner_mismatch', { userId: session.userId })` is recorded. There is no
  token, no session id, and not the other `sub` (FR-007: no credentials or session references).

**PR (a) ordering.** US2 ships in PR (a), *before* server-held tokens. There the refresh token
still comes from the cookie, so the same comparison (`validateJwt(new access).sub === session.userId`)
guards a genuinely client-supplied credential. PR (b) moves the source of the refresh token and
keeps the test.

## R6 — Run-scoped identity fails closed (FR-001 – FR-005)

**Decision.**
- `mintSubjectToken` classifies Keycloak's answer:

  | Keycloak answer | Error | HTTP |
  |---|---|---|
  | `400`/`401` with `error` ∈ {`invalid_token`, `invalid_grant`} | `AgentIdentityError('auth')` | `401`, code `AGENT_IDENTITY_REJECTED` |
  | network error, a 5 s timeout, any `5xx`, **or any other `4xx`** | `AgentIdentityError('transient')` | `503`, code `AGENT_IDENTITY_UNAVAILABLE`, `Retry-After: 5` |

  A misconfigured exchange client (`403 access_denied`) is therefore "temporarily unavailable"
  plus an **error**-level log naming the status. It is not a sign-out, and it is not an
  identity-less run.
- `resolveSubjectToken` in `run+api.ts` and `resume+api.ts`:
  - Unconfigured exchange: returns `undefined`, as today (FR-004).
  - Configured exchange: the error propagates, so the response is produced **before**
    `CopilotRuntime` is constructed or the gateway is called. No step runs.
- Each refusal logs `agent_identity_refused` with `{ outcome: 'auth'|'transient', status }`
  (FR-005). Only the status is logged: no token, no response body (Keycloak echoes nothing
  sensitive, but the rule is no body at all).

**Rationale.**
- The client's existing agent wrapper (`agent-fetch-refresh.ts`) already turns a `/run` 401 into
  `silentRefresh` plus one retry (Acceptance Scenario 2). It ignores 503, so a transient failure
  never signs anyone out (Scenario 3).
- `/run` mints on every request today, the `GET /info` handshake included. That scope is kept: an
  `/info` probe that cannot mint is refused the same way. "Runs no step" holds trivially, and the
  dock's open path already tolerates a 401 through the same wrapper.
- With server-held tokens, `requireAuth` has already renewed a nearly expired access token before
  the mint. An `invalid_token` at the mint therefore means the session's grant was revoked, and the
  401 → refresh → rejected path ends at sign-in, as the spec's edge case requires.

**Client string.** The CopilotKit dock surfaces a non-2xx `/run` as its generic error. A task
verifies what a member sees for 503 and adds the "temporarily unavailable, try again" string if
the generic text is not already accurate (spec Assumptions).

## R7 — Redirect registration records success only on success (FR-010, FR-011)

**Decision.** In `ensureClientRedirectUris`, `redirectUrisEnsured.add` runs only if
`missing.length === 0`, or if the `PUT` returned `res.ok`. Every non-success path (client lookup,
client fetch, `PUT`, or a thrown error) logs `logger.warn('redirect_uri_registration_failed',
{ action, step, status })`. `step` is one of `client_lookup`, `client_fetch`, `update` or
`error`. There is no admin token, no client representation and no URI list. Retry happens
naturally: the next `/auth/init` finds the client id absent from the set.

## R8 — Expiry reason and dead code (FR-012 – FR-014)

**Decision.**
- `getValidSession` is replaced by `readLiveSession(sid)`, which returns `{ session }` or
  `{ expired: 'idle' | 'absolute' | 'missing' }`. Absolute is checked **first**, as today.
- `requireAuth` maps the result:
  - `absolute`: `SESSION_ABSOLUTE_TIMEOUT`, audit `session_expired { reason: 'absolute' }`.
  - `idle`: `SESSION_IDLE_TIMEOUT`, audit reason `idle`.
  - `missing`: `SESSION_NOT_FOUND`.
- `session-timeout.ts` and its `validateSessionTimeout` are **deleted**. The only caller is
  `auth/user+api.ts`, and `requireAuth` now does the job on every route. `validateSessionTimeout`'s
  "double-check" could never fire, because `getValidSession` had already returned `null` for an
  absolute expiry. That is the mislabelling bug.
- `cache-service.updateSessionActivity` is deleted. It has no caller (`grep`).
- The `AuthenticatedRequest` interface in `auth.ts` is deleted for the same reason.
- Comments in `auth.ts` ("Falls back to Authorization header"), `extractSessionId`
  ("cookies/headers"), `session-manager.ts` and `cache-service.ts` are corrected to describe
  cookie-only and per-request idle enforcement (FR-013).

**PR (a) vs (b).**
- PR (a) fixes the absolute-vs-idle mislabelling in `validateSessionTimeout`'s caller. That is
  where the bug is observable today, on `/auth/user`.
- FR-023, the every-request enforcement, needs US6's session read, so it lands in PR (b), which
  also deletes `session-timeout.ts`.

## R9 — Legacy token cookies at rollout (FR-022)

**Decision.**
- Every session-auth failure from `requireAuth` carries `clearCookies: buildClearAuthCookies()` on
  the thrown `AuthError`. That function now also clears the two retired token cookie names, at
  their original Paths.
- The response helpers that turn an `AuthError` into a response append those cookies:
  `handleMcApiError`, `error-handler.ts`, `backup-route-support`, `account-route-support`, and the
  three auth routes.
- Login also clears the retired names on success, so a member who signs in again never keeps a
  stale token cookie.
- The old `mcm_access_token` value is **never read**: no code path parses it after PR (b).

**Rationale.** The old cookies carry no session record that this code will accept: their
`mcm_session_id` points at a record with no `session-tokens:` key. That yields `401
SESSION_NOT_FOUND`, the client's refresh also 401s, and the member lands on sign-in once, as
Acceptance Scenario 6 describes.

Keeping the retired names in the clear list costs one header per 401. It can be dropped one
absolute-lifetime (24 h) after rollout, and a backlog follow-up records that.

## R10 — PR split (openwiki/process/pull-request-batching.md)

| PR | Stories | Why it is separable |
|---|---|---|
| **(a)** | US1, US2, US4, US5 (FR-012 – FR-014 on today's model) | Each changes behaviour on the existing cookie transport. A red build points at one of four small, independent changes. |
| **(b)** | US3, US6, plus FR-023 and the harness and DAST migration | Bearer removal and server-held tokens both change how *every* request authenticates, and they share the harness migration. Splitting them would mean migrating the harness twice, and a red app-e2e could not be attributed. |

## R11 — Tiers each PR must run

- **Both PRs:**
  - `pnpm nx lint mcm-app`, `pnpm nx typecheck mcm-app`, and the unit tests (`pnpm nx test
    mcm-app`, Jest `--maxWorkers=2`);
  - BFF integration (`jest -c jest.integration.config.js`, with `MCM_REQUIRE_LIVE_STACK=1`);
  - the web E2E gate tier with `E2E_REQUIRE_AGENT_STACK=1` and `E2E_TIER=gate`;
  - the SAST and secret scans (guardrails).
- **PR (b) also:**
  - the Android Maestro flows for sign-in, an agent turn and sign-out (US6, SC-007/SC-009), per
    openwiki/runbooks/android-emulator.md;
  - the DAST baseline/full with the migrated login;
  - the `scripts/__tests__` suite (`dast-bff-login`, `zap-scan` and the redaction tests reference
    the cookie names).
- **Agent gateway (Python):** not touched. The gateway still receives a subject token on the same
  header. Its tests run only via the E2E agent tiers.
