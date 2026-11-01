# Implementation Plan: BFF Auth Fail-Closed Hardening

**Branch**: `085-bff-auth-fail-closed` | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/085-bff-auth-fail-closed/spec.md`

## Summary

The BFF's session layer degrades silently where it should refuse. This plan makes it refuse, and
moves the member's tokens off the client. **One authenticator, `requireAuth(headers)`,** becomes
session-cookie-only (research R1, R2). Each request it:

1. reads the session from Redis;
2. enforces absolute expiry, then idle expiry, each with its true reason;
3. decrypts the server-held tokens and renews them at most once under a per-session lock;
4. validates the JWT.

The **bearer path is deleted** in every environment, and the integration harness moves to real
code+PKCE sessions.

The other fixes:
- **Run-scoped identity** failures are split into auth (`401`, which the client renews) and
  transient (`503`, retryable). Neither ever runs an identity-less turn.
- **Refresh** checks that the renewed token belongs to the session owner.
- **Redirect registration** marks itself done only on a confirmed write.

Delivery is **two PRs**:
- **(a)** US1, US2, US4, US5 on today's transport;
- **(b)** US3, US6 and FR-023, plus the harness, E2E and DAST migration.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24. Expo Router API routes (`+api.ts`) on the server, React Native 0.86 / React 19.2 on the client.

**Primary Dependencies**:
- `ioredis` (session store);
- Node `crypto`, through `agent-config-crypto.ts` (AES-256-GCM);
- `jose`, through `token-service.ts` (JWT validation);
- Keycloak 26.5 (token, token-exchange and Admin REST endpoints);
- `@copilotkit/runtime` (agent route).

No new dependency.

**Storage**: Redis.
- `session:{sid}` (unchanged shape), plus the new `session-tokens:{sid}` (an encrypted blob) and
  `session-renew:{sid}` (a lock). See [data-model.md](data-model.md).
- No MongoDB change.

**Testing**:
- Jest, `jest-expo` preset, for unit tests: `src/**/unit-tests`, `tests/app/**`.
- Jest node config for integration (`jest.integration.config.js`): a real BFF container, Keycloak,
  Redis and mc-service, with no mocks (constitution: Test Type Integrity).
- Playwright for web E2E (gate and model-decision tiers), and Maestro for Android.
- `node --test` for `scripts/__tests__`, which holds the DAST helper tests.

**Target Platform**: the BFF container (Linux, Node 24). Clients are web and Android.

**Project Type**: web service (BFF) inside a universal app.

**Performance Goals**: no added network round trip per request.
- The session read and the token read go in one `MGET`, plus the existing touch `SET`.
- Keycloak is called only when the access token is within 30 s of expiry (≈ once per 5 min per
  session).

**Constraints**:
- Fail closed everywhere: no fallback to a client token, an identity-less run or an unencrypted
  token.
- No raw token, session id or refresh token in any log or audit event. This is enforced by the
  logger redaction and the `mcm-no-token-logging` SAST rule.
- The `mcm-auth-before-authz` SAST rule must keep matching. `requireAuth` keeps its name and its
  position before `createMcServiceClient`.

**Scale/Scope**:
- ~20 route handlers change their token source.
- 25 integration files migrate from bearer to session.
- 2 web E2E specs and 3 DAST helpers move off the token cookies.
- 16 unit-test files mock `@/bff-server/auth`, and their mock shape changes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle (constitution v2.7.0) | Status | How |
|---|---|---|
| §Security → Authentication: the client gets only an opaque session-id cookie | **Fixed by US6.** Today it is **violated**: raw access and refresh tokens are sent to the client as HttpOnly cookies. | R3 and R5. Login, refresh and logout set only `mcm_session_id`. |
| §Session Management: "Raw tokens must never be sent to the client" | **Fixed by US6** | same as above |
| §Prohibited Patterns: "parallel authentication paths created for convenience or testing" | **Fixed by US3**. The bearer path is exactly this. | R2: deleted, with no flag. |
| §Session Management: refresh rotation | Holds. The renewal lock (R4) is what keeps rotation from ending sessions under concurrency. | R4 |
| §Session Management: logout terminates the server session **and** the IdP SSO session | Holds. Logout revokes the server-held refresh token and calls `logoutUserSessions`. | contracts §logout |
| §Data Protection → Encryption at Rest (AES-256; keys separate from data) | Holds. AES-256-GCM. The key is an env-provided secret, never in Redis. **Accepted trade-off:** the key is shared with agent config (R3), on the operator's direction. A follow-up item covers a dedicated key. | R3 |
| §Token Validation on every request | Holds. `validateJwt` still runs on every `requireAuth`, now on the server-held token. | R1 |
| §Centralized Access Control | Unchanged posture. Per-route `requireAuth` plus `requireMc*`, guarded structurally by SAST (openwiki/gotchas/role-enforcement-is-a-layer.md). This feature does not move the call site. | R1 |
| §Error Handling: safe error responses | Holds. New codes are generic; the Keycloak status is logged, never returned. | contracts |
| §Logging: audit security events | Adds `session_expired {reason}`, `session_refresh_owner_mismatch`, `session_renewal_rejected`, and `agent_identity_refused` (a log). | R5 – R8 |
| §TDD (NON-NEGOTIABLE) + FR-015 | Every FR gets a RED-first test. Behaviour that already exists (FR-012's absolute check, FR-010) gets a mutation RED. | tasks.md |
| §Test Type Integrity | The integration harness uses a real code+PKCE login against real Keycloak. No `jest.mock` under `tests/integration/`. | R2 |
| §Behavior-descriptive identifiers | New modules `session-tokens.ts` and `bff-session.ts`. No spec IDs in identifiers. | |

**Gate result: PASS.** No unjustified violation. The two pre-existing violations (raw tokens on
the client, the bearer path) are what this feature removes.

*Post-design re-check (after Phase 1):* still PASS. The data model adds no client-visible state.
The contracts add codes but no new route.

## Project Structure

### Documentation (this feature)

```text
specs/085-bff-auth-fail-closed/
├── spec.md
├── plan.md              # this file
├── research.md          # R1–R11 decisions
├── data-model.md        # Redis keys, liveness order, state transitions
├── quickstart.md        # validation guide
├── contracts/bff-auth.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
frontend/mcm-app/
├── src/bff-server/
│   ├── auth.ts                    # requireAuth → session-based; bearer + extractRawToken removed; cookie builders
│   ├── session-tokens.ts          # NEW: seal/open tokens, ensureFreshTokens (lock + single renewal), owner check
│   ├── session-manager.ts         # createSession(userId, tokens); readLiveSession → {session}|{expired}; deletes tokens key
│   ├── cache-service.ts           # MGET session+tokens, SET XX touch, tokens key, delete both; updateSessionActivity removed
│   ├── session-timeout.ts         # DELETED in PR (b) (FR-013/FR-023); PR (a) fixes the absolute-vs-idle label
│   ├── keycloak.ts                # refreshTokens: rejected-vs-transient + timeout; ensureClientRedirectUris: done only on 2xx
│   ├── agent-subject-token.ts     # classify exchange failures (auth | transient), 5 s timeout
│   ├── mc-api-error.ts            # append AuthError.clearCookies; 503 Retry-After
│   ├── error-handler.ts, backup-route-support.ts, account-route-support.ts   # same append
│   └── agent-config-crypto.ts     # + sessionTokensAad()
├── src/app/bff-api/
│   ├── auth/{login,refresh,logout,user}+api.ts
│   ├── agent/{run,resume}+api.ts  # fail closed on identity
│   ├── account/delete-challenge+api.ts   # auth_time from requireAuth payload
│   └── collections/**, agent/**, admin/**, backups/** # accessToken from requireAuth
├── src/types/errors.ts            # 4 new AuthErrorCode values
├── src/utils/{agent-fetch-refresh,token-refresh}.ts  # comments only (cookie model); no behaviour change
├── tests/integration/
│   ├── helpers/bff-session.ts     # NEW: code+PKCE login → Cookie header
│   └── *.integration.test.ts      # 25 files: Bearer → session cookie; new US1–US6 suites
└── tests/e2e/web/{bff-prod-lifecycle,agent-session-refresh}.spec.ts
scripts/dast-bff-login.mjs, scripts/zap-scan.mjs, security/zap/scripts/bff-session-refresh.js
openwiki/invariants/auth-chain.md  # canonical; updated
docs/: auth-chain sources the spec names (MCM-Architecture §Token Custody, BFF runbook) — tasks list them
```

**Structure Decision**: the existing mcm-app layout (constitution §Monorepo for Multiple Frontend
Apps). One new BFF utility module (`session-tokens.ts`) and one new test helper. There is no new
project.

## Delivery: two PRs (research R10)

| PR | Contents | Must be green on |
|---|---|---|
| **(a)** | US1 (FR-001 – 005), US2 (FR-006/007), US4 (FR-010/011), US5 (FR-012 – 014, on today's model) | lint, typecheck, unit, integration, web E2E gate tier, guardrails |
| **(b)** | US3 (FR-008/009), US6 (FR-016 – 022), FR-023; harness, E2E and DAST migration; docs | all of (a), plus Android flows, DAST, `scripts/__tests__` |

PR (b) is based on `main` after PR (a) merges.

## Complexity Tracking

| Choice | Why needed | Simpler alternative rejected because |
|---|---|---|
| Two Redis keys per session | A touch must never overwrite tokens that a concurrent renewal just rotated (R3) | One key with read-modify-write loses rotated refresh tokens under concurrency, which ends sessions. |
| A waiting lock loser, not `withLeaderLock` | The loser needs the winner's *result* | `withLeaderLock`'s "skip if not leader" would make the loser either fail or renew itself, and renewing itself trips rotation. |
| A shared encryption key | Operator direction; no deploy-time operator step | A dedicated key is a follow-up item, because it needs a Komodo Variable before deploy. |
