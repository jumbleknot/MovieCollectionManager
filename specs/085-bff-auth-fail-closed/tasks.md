# Tasks: BFF Auth Fail-Closed Hardening

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md) (R1–R11),
[data-model.md](./data-model.md), [contracts/bff-auth.md](./contracts/bff-auth.md),
[quickstart.md](./quickstart.md)

**Tests**: TDD is mandatory (constitution) and FR-015 requires a failing-first test for each FR.
- Every test task carries a **Verify RED** command and the failure it expects.
- Every implementation task carries a **Verify GREEN** command.
- Where the behaviour already exists, the task says **mutation RED**: revert or alter the code, and
  show that the test fails.

The format follows `docs/templates/feature-test-tasks-template.md`, compacted.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task).
- **[Story]**: US1–US6 from spec.md.
- **PR (a)** = Phases 1–6 (US1, US2, US4, US5 on today's transport).
- **PR (b)** = Phases 7–9 (US3, US6, FR-023), opened from `main` after (a) merges.

## Conventions (apply to every task)

- **Worktree only:** `/home/coder/worktrees/085-bff-auth-fail-closed` for (a), and a fresh worktree
  from `origin/main` for (b). `pnpm nx` there needs that worktree's own `CI=true pnpm install
  --frozen-lockfile`.
- **Commands** are run from the worktree root. `U` and `I` below are shorthand:

  | Shorthand | Expands to |
  |---|---|
  | `U <path>` | `pnpm nx test mcm-app -- --watchAll=false --maxWorkers=2 --testPathPattern '<path>'` (unit) |
  | `I <path>` | `MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app -- --testPathPattern '<path>'`, against the BFF container on :8082, rebuilt after each server change (`pnpm nx docker-build mcm-app && pnpm nx docker-up mcm-app`) |
- **Skip count:** an integration RED or GREEN with any `skipped` is not evidence.
- **Ignore Expected-RED text for import errors:** a RED that fails only because a module does not
  exist yet counts. A RED that fails for an unrelated reason does not.

---

## Phase 1: Setup

- [ ] T001 Rebase `085-bff-auth-fail-closed` on `origin/main` and run `CI=true pnpm install
  --frozen-lockfile` in the worktree. **Done when**: `pnpm nx typecheck mcm-app` is clean on the
  unchanged tree, which is the baseline.
- [ ] T002 Record the baselines in `specs/085-bff-auth-fail-closed/baseline.md`:
  - the counts from `grep -lE "Authorization: \`Bearer" frontend/mcm-app/tests/integration/*.test.ts`
    (expect 25) and `grep -rln "extractRawToken" frontend/mcm-app/src` (expect 21);
  - whether CI's integration BFF sets `TRUSTED_PROXY` (`.forgejo/workflows/app-ci.yml`), which
    decides the R2 login-rate-limit branch;
  - the SC-002 baseline (runs 5618, 5748, 5757, 5820).

  **Done when**: the file lists each number with the command that produced it.

## Phase 2: Foundational (blocks US1, US2, US6)

- [ ] T003 [P] Add `AGENT_IDENTITY_REJECTED`, `AGENT_IDENTITY_UNAVAILABLE`,
  `SESSION_RENEWAL_PENDING` and `SESSION_OWNER_MISMATCH` to `AuthErrorCode` in
  `frontend/mcm-app/src/types/errors.ts`, and an optional `clearCookies?: string[]` and
  `retryAfterSeconds?: number` on `AuthError`. **Done when**: typecheck is clean.
- [ ] T004 Test `frontend/mcm-app/src/bff-server/unit-tests/mc-api-error.test.ts`, with new cases:
  - an `AuthError` carrying `clearCookies` yields one `Set-Cookie` per entry;
  - a 503 `AuthError` with `retryAfterSeconds` yields `Retry-After`.

  **Verify RED**: `U mc-api-error.test`. Expected: 2 failing (no `set-cookie`, no `retry-after`).
- [ ] T005 Implement the append in `handleMcApiError` (`src/bff-server/mc-api-error.ts`) and in the
  other AuthError→Response helpers (`error-handler.ts`, `backup-route-support.ts`,
  `account-route-support.ts`), through one shared `authErrorHeaders(err)` in `mc-api-error.ts`.
  **Verify GREEN**: `U mc-api-error.test`, then `U error-handler.test`.

---

## Phase 3: US1 — the assistant refuses a turn it cannot attribute (P1) 🎯 MVP

**Independent test**: Keycloak rejects the token exchange, and the turn is refused before any
gateway call; a transient failure gives 503; unconfigured exchange runs as today.

- [ ] T006 [P] [US1] Unit test `src/bff-server/unit-tests/agent-subject-token.test.ts`, covering
  AS-1 and AS-3 and the edge-case timeout. With a mocked `fetch`:
  - `400 {"error":"invalid_token"}` and `401` throw `AgentIdentityError` with `outcome: 'auth'`;
  - `503`, `500`, a rejected fetch, an `AbortSignal` timeout and `403 {"error":"access_denied"}`
    throw with `outcome: 'transient'`;
  - every failure logs `agent_identity_refused {outcome,status}`, and the serialised log contains
    neither the subject token nor the response body (FR-005).

  **Verify RED**: `U agent-subject-token.test`. Expected: fails, `AgentIdentityError is not exported`.
- [ ] T007 [US1] Implement it in `src/bff-server/agent-subject-token.ts`:
  - `AgentIdentityError` with `outcome` and a mapping to `AuthError`. `auth` maps to
    `401 AGENT_IDENTITY_REJECTED`; `transient` maps to `503 AGENT_IDENTITY_UNAVAILABLE`,
    `retryAfterSeconds 5`.
  - `AbortSignal.timeout(5000)` on the exchange fetch.
  - The log level is `warn` for auth and `error` for transient.

  **Verify GREEN**: `U agent-subject-token.test`.
- [ ] T008 [P] [US1] Unit test `src/bff-server/unit-tests/agent-run-api.test.ts` and
  `agent-resume.test.ts`, covering AS-1, AS-3, AS-4 and AS-5 (FR-001 – FR-004). With exchange
  configured:
  - a mint that throws `auth` gives `401 AGENT_IDENTITY_REJECTED`, and **`createMovieAssistantAgent`
    / `resumeMovieAssistantRun` is never called** (spy);
  - a `transient` throw gives `503` plus `Retry-After`, and it is never called either;
  - with exchange unconfigured, the gateway factory is called with `subjectToken: undefined`.

  **Verify RED**: `U 'agent-run-api.test|agent-resume.test'`. Expected: the four configured cases
  fail. Today's code swallows the error and calls the gateway.
- [ ] T009 [US1] Implement it in `src/app/bff-api/agent/run+api.ts` and `resume+api.ts`:
  - `resolveSubjectToken` no longer catches. An `AgentIdentityError` becomes its `AuthError` and
    reaches `handleMcApiError`.
  - Update the header comments, which say "a mint failure is non-fatal".

  **Verify GREEN**: `U 'agent-run-api.test|agent-resume.test'`, then `U 'tests/app/bff-api/agent'`.
- [ ] T010 [US1] Integration test `tests/integration/agent-identity-refusal.integration.test.ts`,
  covering AS-1 and SC-001 against the real BFF and Keycloak. A member whose Keycloak user sessions
  were ended through the Admin API (`logoutUserSessions`), so the access token is still
  signature-valid but the exchange answers `invalid_token`, POSTs a billable `/run`. Expect `401
  AGENT_IDENTITY_REJECTED`, and that the gateway received no run (assert on the gateway's run log,
  or the absence of a thread checkpoint for the thread id). **Verify RED**: `I
  agent-identity-refusal`. Expected: `200` streamed, not `401`. **Verify GREEN**: after T009 and a
  container rebuild.
- [ ] T011 [US1] Check the client outcome for 503. Drive the dock in web E2E with the BFF's exchange
  client secret deliberately wrong, or verify in a unit test of the dock error renderer, whichever
  exists. If the shown text is not "The assistant is temporarily unavailable. Please try again.",
  add that string for `AGENT_IDENTITY_UNAVAILABLE` where the dock maps run errors
  (`src/components/agent/`). **Done when**: the member-visible text for 503 is recorded in
  `baseline.md`, with a screenshot or test name.

## Phase 4: US2 — refresh extends only the caller's own session (P1)

**Independent test**: member A's session plus member B's refresh token is refused, A's activity is
unchanged, no cookies are set, and the mismatch is audited.

- [ ] T012 [P] [US2] Unit test `tests/app/bff-api/auth/refresh+api.test.ts`, covering AS-1, AS-2
  and SC-003. Mock `refreshTokens` to return an access token whose (mocked) `validateJwt` payload
  has `sub` B, for a session owned by A. Expect:
  - `401 SESSION_OWNER_MISMATCH`;
  - `touchSession` not called, and no `set-cookie` other than clears;
  - `logger.audit('session_refresh_owner_mismatch', {userId: A})` with no `sessionId` and no token
    in the serialised entry.

  The same-owner case still gives `200`. **Verify RED**: `U 'auth/refresh\+api.test'`. Expected:
  the mismatch case fails with `200`.
- [ ] T013 [US2] Implement it in `src/app/bff-api/auth/refresh+api.ts`. After `refreshTokens`,
  `validateJwt(tokens.access_token)`. If `payload.sub !== session.userId`:
  - `revokeToken(tokens.refresh_token, 'refresh_token')`;
  - `terminateSession(sessionId, session.userId)`;
  - audit the mismatch;
  - return `401` with the clear cookies.

  **Verify GREEN**: `U 'auth/refresh\+api.test'`.
- [ ] T014 [US2] Integration test in `tests/integration/auth-refresh.integration.test.ts`, covering
  AS-1. Log member A in, which creates a real session. Then call `/bff-api/auth/refresh` with A's
  `mcm_session_id` and B's ROPC **refresh token** as `mcm_refresh_token`. Expect `401
  SESSION_OWNER_MISMATCH`, A's session gone from Redis db 1, and an audit line captured through
  `audit-log-capture`. **Verify RED**: against the pre-T013 container. Expected: `200`.
  **Verify GREEN**: after rebuild.

## Phase 5: US4 — redirect registration recovers from a rejected update (P3)

- [ ] T015 [P] [US4] Unit test `src/bff-server/unit-tests/keycloak.test.ts`, covering AS-1 – AS-3
  and SC-005. With mocked fetch:
  1. lookup ok, fetch ok, `PUT` 403: the second call `PUT`s again, and `logger.warn
     ('redirect_uri_registration_failed', {step:'update', status:403})` is logged without
     `redirectUris`, the client JSON or the admin token;
  2. `PUT` 204: no further `PUT`;
  3. nothing missing: no `PUT`, and it is marked done;
  4. lookup 500: retried, and warns with `step:'client_lookup'`.

  **Verify RED**: `U keycloak.test`. Expected: case 1 makes only one `PUT` (latched), and the warn
  is absent.
- [ ] T016 [US4] Implement it in `ensureClientRedirectUris` in `src/bff-server/keycloak.ts`: mark
  done only on nothing-missing or `res.ok`, and warn at each failure step and in `catch`.
  **Verify GREEN**: `U keycloak.test`. **Mutation RED**: move `redirectUrisEnsured.add` back above
  the `res.ok` check, and case 1 fails.

## Phase 6: US5 — expiry is reported as it behaves (P3), today's transport

- [ ] T017 [P] [US5] Unit test `src/bff-server/unit-tests/session-manager.test.ts` and
  `session-timeout.test.ts`, covering AS-1, AS-2, FR-012 and SC-006:
  - `readLiveSession` returns `{expired:'absolute'}` for `now > expiresAt`, even when also idle;
  - it returns `{expired:'idle'}` for idle-only, and `{expired:'missing'}` for an absent record;
  - `validateSessionTimeout` throws `SESSION_ABSOLUTE_TIMEOUT` for absolute and `IDLE` for idle,
    and emits `audit('session_expired',{reason})`.

  **Verify RED**: `U 'session-manager.test|session-timeout.test'`. Expected: `readLiveSession is
  not a function`, and the absolute case receives `SESSION_IDLE_TIMEOUT`.
- [ ] T018 [US5] Implement `readLiveSession` in `src/bff-server/session-manager.ts`, keeping
  `getValidSession` as a thin wrapper until PR (b). Rewrite `validateSessionTimeout` to use it, and
  remove the unreachable "double-check". **Verify GREEN**: as T017.
- [ ] T019 [US5] FR-013 and FR-014: delete `updateSessionActivity` from
  `src/bff-server/cache-service.ts` and the unused `AuthenticatedRequest` from `auth.ts`. Correct
  the comments in `session-timeout.ts` ("every authenticated BFF request" → the routes that call
  it, which in PR (a) is `/auth/user`), `auth.ts` and `extractSessionId` (cookie-only, not
  headers). **Done when**: `grep -rn "updateSessionActivity\|AuthenticatedRequest" frontend/mcm-app/src`
  prints nothing, and typecheck is clean.

## Checkpoint (a): PR (a) gates

- [ ] T020 Run `pnpm nx lint mcm-app`, `pnpm nx typecheck mcm-app`, the full unit suite, and the
  integration suite with `MCM_REQUIRE_LIVE_STACK=1` (0 skipped), on a rebuilt container. **Done
  when**: all are green locally, with outputs saved under the session scratchpad.
- [ ] T021 Open PR (a) with the real-branch recipe, watch it with `ci-status.mjs watch --pr N
  --required-only`, and merge it on green. Verify with `git merge-base --is-ancestor`, and remove
  the worktree.

---

## Phase 7: US3 — the server accepts only the session cookie (P2) [PR (b)]

- [ ] T022 [US3] Create `tests/integration/helpers/bff-session.ts`, `loginSession(username,
  password)`, which returns a `Cookie` header string. It:
  1. calls `GET /bff-api/auth/init`;
  2. walks Keycloak authorize (PKCE S256, `redirect_uri=${BFF}/auth-callback`) → password → code,
     by generalising `walkStepUpLogin` in `keycloak-browser-flow.ts` with an option to omit
     `max_age=0`;
  3. calls `POST /bff-api/auth/login`;
  4. returns `cookieHeaderFrom(res)`.

  If T002 found `TRUSTED_PROXY=true`, it sends a per-user `X-Forwarded-For`. **Done when**: a
  scratch test using it gets `200` from `/bff-api/auth/user`.
- [ ] T023 [US3] Integration test `tests/integration/bff-bearer-refused.integration.test.ts`,
  covering AS-1, AS-2, SC-004 and SC-010:
  - a ROPC access token as `Authorization: Bearer` alone, on `/bff-api/collections`,
    `/bff-api/auth/user` and `/bff-api/agent/run` (GET), gives `401` on each;
  - a bearer for member B plus member A's session cookie gives `200` with A's identity on
    `/auth/user`.

  **Verify RED**: against the PR (a) container. Expected: `200` for the bearer-only cases.
- [ ] T024 [US3] Unit test `src/bff-server/unit-tests/auth.test.ts`, covering AS-1 and AS-2:
  - `requireAuth({authorization:'Bearer x'})` throws `SESSION_NOT_FOUND` without calling
    `validateJwt` (spy);
  - `extractRawToken` is no longer exported (`expect(auth).not.toHaveProperty('extractRawToken')`).

  **Verify RED**: `U 'bff-server/unit-tests/auth.test'`.

## Phase 8: US6 — the member's tokens never leave the server (P2) [PR (b)]

**Independent test**: across login, renewal and logout, no response sets a token cookie; Redis
holds only ciphertext; concurrent expiry renews once; pre-rollout cookies are cleared once.

- [ ] T025 [P] [US6] Unit test `src/bff-server/unit-tests/session-tokens.test.ts`, covering FR-017,
  FR-018, FR-019, FR-006 and SC-008:
  - `sealSessionTokens` / `openSessionTokens` round-trip, and fail for another session id or user
    id (AAD);
  - the sealed JSON contains no `eyJ` substring;
  - `ensureFreshTokens` returns the tokens unchanged when more than 30 s remain;
  - it renews once when two calls race (the mocked `setLockIfAbsent` gives one winner; the loser
    polls and receives the winner's tokens; `refreshTokens` is called exactly once);
  - a rejected renewal deletes both keys and throws `401 REFRESH_FAILED`;
  - a transient renewal keeps the keys and throws `503 KEYCLOAK_UNAVAILABLE`;
  - a renewed token with a different `sub` throws `401 SESSION_OWNER_MISMATCH` and persists nothing;
  - a loser timing out throws `503 SESSION_RENEWAL_PENDING`.

  **Verify RED**: `U session-tokens.test`. Expected: `Cannot find module '@/bff-server/session-tokens'`.
- [ ] T026 [P] [US6] Unit test `src/bff-server/unit-tests/cache-service.test.ts`, covering
  data-model.md:
  - `cacheSessionTokens` writes `session-tokens:{sid}` with the session's TTL;
  - `getSessionWithTokens` uses one `mget`;
  - `touchSession` uses `SET … XX` and never writes the tokens key;
  - `deleteSession` deletes both keys.

  **Verify RED**: `U 'cache-service.test'`.
- [ ] T027 [US6] Implement:
  - `src/bff-server/keycloak.ts`: `refreshTokens` raises `AuthError(REFRESH_FAILED, 401)` on
    `400`/`401`, and `AuthError(KEYCLOAK_UNAVAILABLE, 503, retryAfterSeconds 5)` on a network error,
    a 5 s `AbortSignal.timeout` or `5xx`.
  - `src/bff-server/agent-config-crypto.ts`: `sessionTokensAad(sid, userId)`.
  - `src/bff-server/cache-service.ts`: the tokens key, `mget`, the `SET XX` touch, and delete of
    both keys; add `mget` and the `XX` overload to `RedisLike`.
  - The new `src/bff-server/session-tokens.ts`: seal/open, `ensureFreshTokens` with
    `setLockIfAbsent('session-renew:'+sid, holder, 15)` and `releaseLockIfHeld`, poll 100 ms × 50,
    and the owner check.
  - `session-manager.ts`: `createSession(userId, tokens)` seals and stores the tokens; eviction and
    `terminateAllSessions` delete the tokens; `getValidSession` is removed.

  **Verify GREEN**: `U 'session-tokens.test|cache-service.test|session-manager.test|keycloak.test'`.
- [ ] T028 [US6] Implement `requireAuth` in `src/bff-server/auth.ts` as described in research R1. It
  returns `{payload, user, accessToken, session}`; every failure carries `clearCookies:
  buildClearAuthCookies()`; `extractToken` and `extractRawToken` are deleted (US3).
  - `buildAuthCookies(sessionId)` sets only `mcm_session_id`, with Max-Age equal to the remaining
    absolute lifetime.
  - `buildClearAuthCookies()` clears `mcm_session_id` and the two retired names at their original
    Paths. Comment that this keeps the retired names until one absolute lifetime after rollout
    (FR-022).
  - Delete `src/bff-server/session-timeout.ts` and its unit test, since FR-023 is now enforced
    inside `requireAuth`.

  **Verify GREEN**: `U 'bff-server/unit-tests/auth.test'` (T024 plus new cases):
  - idle, absolute and missing each give their code (FR-023);
  - a valid session touches it;
  - near-expiry renews it;
  - the retired cookie alone gives `SESSION_NOT_FOUND` plus clear cookies.
- [ ] T029 [US6] Migrate every route to the new result: `const { user, accessToken } = await
  requireAuth(headers)`, replacing each `extractRawToken(headers)!`. The routes are:
  - `src/app/bff-api/collections/**`, `agent/**` (run and resume mint from `accessToken`),
    `account/delete-challenge+api.ts` (`auth_time` from `payload`), `admin/**`, `auth/user+api.ts`
    (drop `validateSessionTimeout`), and `backup-route-support.ts`.

  **Done when**: `grep -rn "extractRawToken\|validateSessionTimeout\|ACCESS_TOKEN_COOKIE\|REFRESH_TOKEN_COOKIE"
  frontend/mcm-app/src` prints only the retired-name constants inside `buildClearAuthCookies`, and
  typecheck is clean.
- [ ] T030 [US6] Unit tests for the auth routes, covering AS-1, AS-3, AS-6, FR-016, FR-020 and
  FR-022, in `tests/app/bff-api/auth/{login,refresh,logout}+api.test.ts` and
  `src/bff-server/unit-tests/login-api.test.ts`:
  - **login:** the `set-cookie` set is exactly `mcm_session_id` plus two `Max-Age=0` retired names;
    no header value contains the access-token or refresh-token string; `createSession` receives the
    tokens.
  - **refresh:** it forces a renewal through `ensureFreshTokens`; it sets only `mcm_session_id`;
    the US2 mismatch case still holds.
  - **logout:** it revokes the **server-held** refresh token, calls `logoutUserSessions`, and
    deletes both keys; without a session, it clears only.

  **Verify RED**: `U 'tests/app/bff-api/auth|login-api.test'`. Expected: the cookie-set assertions
  fail.
- [ ] T031 [US6] Implement `auth/login+api.ts`, `refresh+api.ts` and `logout+api.ts` per
  contracts/bff-auth.md. **Verify GREEN**: as T030.
- [ ] T032 [US6] Update the remaining unit tests that mock `@/bff-server/auth`, so their mocks
  return `accessToken` and drop `extractRawToken`. These are the 16 files from `grep -rln
  "jest.mock('@/bff-server/auth'" frontend/mcm-app/src frontend/mcm-app/tests`, plus any test that
  passes `Authorization: Bearer` to a route handler. **Do not weaken an assertion**: where a test
  asserted that a bearer authenticates, it now asserts `401`. **Verify GREEN**: the full unit suite,
  `pnpm nx test mcm-app -- --watchAll=false --maxWorkers=2`, with 0 failed.
- [ ] T033 [US6] Integration test `tests/integration/session-token-custody.integration.test.ts`,
  covering AS-1 – AS-6, SC-007 and SC-008:
  1. `loginSession` sets only `mcm_session_id`;
  2. the Redis db-1 `session-tokens:*` values contain no `eyJ`;
  3. the access token is aged artificially, by rewriting `accessExpiresAt` through the BFF's own
     `cacheSessionTokens` with real Redis and the real key, and two concurrent
     `/bff-api/collections` both give `200`, with the Keycloak refresh happening once (assert one
     new `session_renewed` audit line);
  4. logout, then the same cookie gives `401`, and Keycloak introspection of the old refresh token
     reports inactive;
  5. a request with only `mcm_access_token=<ropc token>` gives `401` with clearing `Set-Cookie`.

  **Verify RED**: against the PR (a) container (cookies still set). **Verify GREEN**: after T031
  and a rebuild.
- [ ] T034 [US6] Migrate the 25 integration files from bearer to `loginSession`. Mechanically:
  - `getTestTokens(u,p)` → `loginSession(u,p)`;
  - `auth(t)` → `{ headers: { Cookie: t } }`;
  - keep ROPC only where a raw token goes to Keycloak or mc-service, never to the BFF.

  Each file's assertions stay as they are. **Done when**: `grep -lE "Authorization: \`Bearer"
  frontend/mcm-app/tests/integration/*.test.ts | wc -l` prints `0` (SC-010), and `I .` gives 0
  failed and 0 skipped.
- [ ] T035 [US6] Web E2E: rewrite `tests/e2e/web/bff-prod-lifecycle.spec.ts` and
  `tests/e2e/web/agent-session-refresh.spec.ts` for the server-held model:
  - assert that the cookie jar holds `mcm_session_id` only, still `HttpOnly`, `Strict` and, on the
    prod container, `Secure`;
  - simulate expiry server-side, by aging `accessExpiresAt` through a test-only Redis write the spec
    already has access to via the e2e Redis helper, or by waiting one Keycloak lifespan in the
    model tier;
  - assert the transparent renewal causes no login prompt (SC-009);
  - logout gives `401` on reuse.

  Keep each test's `@gate` / `@model-decision` tag. **Verify RED**: against the PR (a) build. The
  "only `mcm_session_id`" assertion fails. **Verify GREEN**: gate tier with
  `E2E_REQUIRE_AGENT_STACK=1`, in the Playwright image.
- [ ] T036 [US6] DAST:
  - `scripts/dast-bff-login.mjs` returns `{ mcm_session_id }` and checks only that;
  - `scripts/zap-scan.mjs` `probeAuthenticatedUrls` sends only `mcm_session_id`;
  - `security/zap/scripts/bff-session-refresh.js` sends the session cookie, and on a 401 calls
    `/bff-api/auth/refresh` with the session cookie only;
  - update `security/zap/contexts/README.md`.

  Update the matching `scripts/__tests__` (`grep -ln "mcm_access_token" scripts/__tests__`). Keep
  the redaction tests, which must still scrub a session id. **Verify RED/GREEN**: `node --test
  --test-reporter=tap scripts/__tests__/<file>`.
- [ ] T037 [US6] Android:
  - run the sign-in, assistant-turn and sign-out Maestro flows per
    openwiki/runbooks/android-emulator.md (the CI `android-e2e` job for agent flows, the local
    emulator otherwise);
  - add a flow step, or a BFF-side audit check, showing that no token cookie was set during the
    journey (SC-007);
  - update the comments in `src/utils/agent-fetch-refresh.ts`, `token-refresh.ts` and
    `assistant-polyfills.ts` that describe the `mcm_access_token` cookie.

  **Done when**: the flows pass, and the evidence is linked from `baseline.md`.

## Phase 9: Polish & documentation [PR (b)]

- [ ] T038 [P] Update `openwiki/invariants/auth-chain.md` (canonical):
  - client holds the session id only, with the tokens server-held and encrypted;
  - per-request idle and absolute enforcement;
  - renewal lock;
  - no bearer, in any environment (FR-009's "recorded next to the code and in the auth-chain
    documentation");
  - fail-closed run-scoped identity;
  - redirect-registration retry.

  Then update the constitution-facing docs that state the old model: the `docs/` sources cited by
  `openwiki/projects/bff.md` and `openwiki/architecture/agent-layer.md`, found with `grep -rln
  "mcm_access_token\|Authorization: Bearer" docs openwiki --include=*.md`. **Do not hand-edit
  derived openwiki pages**; edit their `resource`. **Done when**: `pnpm nx okf-lint
  infrastructure-as-code` and `pnpm nx okf-governance infrastructure-as-code` pass.
- [ ] T039 [P] Note the FR-009 decision in a comment above `requireAuth` in
  `src/bff-server/auth.ts`, with the date, "operator decision", and that there is no environment
  flag. **Done when**: the comment exists, and the SAST `mcm-auth-before-authz` scan is clean.
- [ ] T040 File two backlog follow-ups (`node scripts/backlog.mjs create`):
  - a dedicated `SESSION_TOKEN_ENC_KEY`, which needs a Komodo Variable (research R3);
  - dropping the retired cookie names from `buildClearAuthCookies` 24 h after rollout (R9).

  **Done when**: both item numbers are recorded in `baseline.md`.
- [ ] T041 Run the PR (b) gates:
  - lint, typecheck, unit, integration (0 skipped), web E2E gate tier (`E2E_REQUIRE_AGENT_STACK=1`),
    Android flows, and `node --test scripts/__tests__/*.test.mjs`;
  - open PR (b), watch it, merge on green, and verify on main.
- [ ] T042 Post-merge: verify SC-001 and SC-003 – SC-010 on `main` (the test names plus CI run
  links). Record the SC-002 baseline, and post a comment that it needs 10 gate-tier runs. Close
  items #844, #607 and #753 with an evidence comment per acceptance criterion.

---

## Dependencies

- Phase 2 (T003 – T005) blocks every story.
- US1 (T006 – T011), US2 (T012 – T014), US4 (T015 – T016) and US5 (T017 – T019) are mutually
  independent → PR (a).
- US3 and US6 (T022 – T037) need PR (a) merged.
  - T022 blocks T023, T033 and T034.
  - T027 blocks T028; T028 blocks T029 – T031; T029 blocks T032.
  - T033 – T036 need T031.
- T038 – T042 come last.

## Parallel opportunities

- PR (a): T006, T008, T012, T015 and T017 are test files in different modules, so they can be
  written in parallel. Then implement T007, T009, T013, T016 and T018 in any order.
- PR (b): T025, T026 and T024 in parallel. T036 (DAST, scripts) and T038 (docs) can proceed in
  parallel with T034 (harness migration).

## Implementation strategy

- **MVP = US1 (Phase 3).** It is the only story with user-visible harm today, and it is what
  SC-002 measures.
- Ship PR (a) with US1, US2, US4 and US5. Then PR (b) moves the transport in one cut, since bearer
  removal and server-held tokens share the harness migration.
