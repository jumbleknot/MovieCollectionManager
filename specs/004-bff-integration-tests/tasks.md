# Tasks: BFF Integration Test Replacement (004-bff-integration-tests)

**Branch**: `004-bff-integration-tests` | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

---

## Phase 0: Keycloak + Test Infrastructure

> All subsequent phases depend on this. Complete and verify before writing any test files.

### T001 — Create mcm-bff-test Keycloak client

**Type**: Configuration | **Time**: 20 min | **Risk**: None

**Spec reference**: FR-001

In the Keycloak Admin UI (`http://localhost:8099`, realm `jumbleknot`):

1. Create a new client: `mcm-bff-test`
2. Enable **Direct Access Grants** (Resource Owner Password Credentials)
3. Set access type to **Confidential**; generate a client secret
4. Add the client secret to `frontend/mcm-app/.env.e2e.local`:
   ```
   E2E_ROPC_CLIENT_ID=mcm-bff-test
   E2E_ROPC_CLIENT_SECRET=<generated-secret>
   ```
5. Document the setup steps in `quickstart.md`

**Done when**: A ROPC token request succeeds:
```bash
curl -s -X POST http://localhost:8099/realms/jumbleknot/protocol/openid-connect/token \
  -d "grant_type=password&client_id=mcm-bff-test&client_secret=<secret>&username=$E2E_TEST_USER&password=$E2E_TEST_PASSWORD&scope=openid" \
  | jq .access_token
```
**Expected**: A non-null JWT string.

---

### T002 — Create keycloak-test-client.ts helper

**Type**: New file (test helper) | **Time**: 45 min | **Risk**: Low

**Spec reference**: FR-001, FR-002, FR-005

**File**: `frontend/mcm-app/tests/integration/helpers/keycloak-test-client.ts`

Use raw `fetch` against the Keycloak token + Admin REST endpoints, mirroring `src/bff-server/keycloak.ts` (`getAdminToken` via client-credentials grant → bearer token → `/admin/realms/{realm}/users`). Do **not** add `@keycloak/keycloak-admin-client` — it is not a project dependency; the BFF itself uses raw `fetch`.

Implement:
- `getTestTokens(username, password)` — ROPC token acquisition (raw `fetch` to the token endpoint with the direct-grant test client)
- `createTestUser(usernamePrefix)` — creates a unique test user via the Admin REST API, returns `{ userId, username, password }`
- `deleteTestUser(userId)` — deletes the test user via the Admin REST API; swallows 404
- `getUserSessions(userId)` — returns active Keycloak sessions for the user (for logout verification)
- `assignRole(userId, roleName)` — assigns a client role (e.g., `mc-user`) to the user

**Verify RED** (before helper exists):
```bash
cd frontend/mcm-app && pnpm exec tsc --noEmit
```
**Expected RED**: No errors yet (file doesn't exist). Once a test file imports it, missing module errors appear.

**Verify GREEN** (after helper created):
```bash
cd frontend/mcm-app && pnpm exec tsc --noEmit
```
**Expected GREEN**: 0 TypeScript errors. Smoke test:
```bash
cd frontend/mcm-app && pnpm exec ts-node -e "
  const { getTestTokens } = require('./tests/integration/helpers/keycloak-test-client');
  getTestTokens(process.env.E2E_TEST_USER, process.env.E2E_TEST_PASSWORD).then(t => console.log('OK:', !!t.accessToken));
"
```
**Expected**: `OK: true`

**Done when**: Helper exports all five functions; TypeScript clean; smoke test returns `OK: true`.

---

### T003 — Create redis-test-client.ts helper

**Type**: New file (test helper) | **Time**: 20 min | **Risk**: None

**Spec reference**: FR-003, FR-006

**File**: `frontend/mcm-app/tests/integration/helpers/redis-test-client.ts`

Connect to Redis database index 1 (isolated from the running BFF on db 0):

```typescript
import Redis from 'ioredis';

const redis = new Redis({ host: 'localhost', port: 6379, db: 1 });

export async function redisGet(key: string): Promise<string | null>;
export async function redisTtl(key: string): Promise<number>;  // -2 = missing, -1 = no TTL
export async function redisExists(key: string): Promise<boolean>;
export async function redisDel(key: string): Promise<void>;
export async function redisKeys(pattern: string): Promise<string[]>;
export async function redisFlushDb(): Promise<void>;  // flush db 1 only — used in beforeAll
export async function closeRedis(): Promise<void>;    // call in afterAll
```

**Verify GREEN**:
```bash
cd frontend/mcm-app && pnpm exec tsc --noEmit
```
Smoke test:
```bash
pnpm exec ts-node -e "
  const { redisGet, closeRedis } = require('./tests/integration/helpers/redis-test-client');
  redisGet('non-existent-key').then(v => { console.log('OK:', v === null); closeRedis(); });
"
```
**Expected**: `OK: true`

**Done when**: Helper exports all functions; connects to db 1; smoke test passes.

---

### T004 — Create bff-test-server.ts helper

**Type**: New file (test helper) | **Time**: 15 min | **Risk**: None

**Spec reference**: FR-004

**File**: `frontend/mcm-app/tests/integration/helpers/bff-test-server.ts`

No new dependencies. Use a plain axios instance and capture/replay the session cookie manually from the `set-cookie` response header (the same approach used by feature 003's cleanup/probe scripts) — `axios-cookiejar-support`/`tough-cookie` are NOT installed and must not be added.

```typescript
import axios from 'axios';

const BASE = process.env.BFF_BASE_URL ?? 'http://localhost:8081';

export function createBffClient() {
  return axios.create({ baseURL: BASE, validateStatus: () => true });
}

/** Extract the session cookie(s) from a login/refresh response for replay on later requests. */
export function cookieHeaderFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie'] as string[] | undefined;
  return (setCookie ?? []).map((c) => c.split(';')[0]).join('; ');
}
// Usage: const r = await bff.post('/bff-api/auth/login', ...); const cookie = cookieHeaderFrom(r);
//        await bff.get('/bff-api/auth/user', { headers: { Cookie: cookie } });
```

**Verify GREEN**:
```bash
cd frontend/mcm-app && pnpm exec tsc --noEmit
```
**Expected GREEN**: 0 TypeScript errors.

**Done when**: Helper exports `createBffClient`; TypeScript clean.

---

### T004a — Create the integration Jest config (Node env + Redis db-1 isolation) and wire the target

**Type**: Config (test infrastructure) | **Time**: 45 min | **Risk**: Medium — changes how integration tests run

**Spec reference**: FR-004, FR-006

The current `test:integration` target runs `jest --testPathPattern=tests/integration` using the **package.json jest config** (the `jest-expo`/RN preset) — there is no integration config. Module-level tests need a **Node** environment and the Redis **db-1** override before modules load. Without this, `session-manager.ts`/`rate-limiter.ts` connect to db 0 while `redis-test-client.ts` reads db 1, and every key assertion fails.

1. Create `frontend/mcm-app/jest.integration.config.js`:
   - `testEnvironment: 'node'`
   - `testMatch: ['<rootDir>/tests/integration/**/*.integration.test.ts']`
   - `setupFiles: ['<rootDir>/tests/integration/setup/env.ts']`
   - TS transform (babel-jest, as the unit config) + `moduleNameMapper` for `@/` → `<rootDir>/src/` (reuse the tsconfig `paths`)
2. Create `frontend/mcm-app/tests/integration/setup/env.ts`:
   ```typescript
   // Runs before any module loads, so `env.redisUrl` (read at module init) picks up db 1.
   process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1';
   ```
   (Confirmed feasible: `cache-service.ts` does `new Redis(env.redisUrl)` and `env.redisUrl = requireEnv('REDIS_URL', …)` read at module init.)
3. Point the Nx target at it — `frontend/mcm-app/project.json` `test:integration` command:
   ```
   jest --config jest.integration.config.js --watchAll=false
   ```
4. Exclude integration tests from the **unit** target — add `"/tests/integration/"` to `testPathIgnorePatterns` in the package.json `jest` block, so `pnpm nx test mcm-app` (unit, no live services) no longer runs them.

**Verify GREEN**:
```bash
pnpm nx test mcm-app -- --listTests        # integration files NOT listed (unit excludes them)
pnpm nx test:integration mcm-app -- --listTests  # only *.integration.test.ts listed, Node env
```
**Done when**: integration config exists with Node env + db-1 override; unit target excludes `tests/integration/`; `test:integration` uses the new config.

---

## Phase 1: Token Service Integration Tests

### T005 — Write token-service integration tests (RED)

**Type**: New test file | **Time**: 45 min | **Risk**: Low

**Scenarios covered**:
- US1-AC1: Valid Keycloak JWT is validated; claims correctly extracted
- US1-AC2: Expired JWT rejected with `TOKEN_EXPIRED`
- US1-AC3: Tampered JWT rejected with `INVALID_TOKEN`
- US1-AC4: JWT missing `mc-user` role returns empty roles

**File**: `frontend/mcm-app/tests/integration/token-service.integration.test.ts`

```typescript
// NOTE: The PKCE code exchange step (keycloak.exchangeCode) is out of scope.
// It is covered by the Playwright global setup in feature 003.
// These tests begin after token acquisition.

import { getTestTokens, createTestUser, deleteTestUser } from './helpers/keycloak-test-client';
// Actual exports: validateJwt (NOT validateToken), extractRoles, isTokenExpired, validateAtHash.
import { validateJwt, extractRoles } from '@/bff-server/token-service';

describe('token-service — integration', () => {
  let userId: string;
  let username: string;
  let password: string;
  let accessToken: string;

  beforeAll(async () => {
    ({ userId, username, password } = await createTestUser('int-token'));
    ({ accessToken } = await getTestTokens(username, password));
  });

  afterAll(async () => {
    await deleteTestUser(userId);
  });

  it('validates a real Keycloak JWT', async () => { ... });
  it('rejects an expired JWT', async () => { ... });
  it('rejects a tampered JWT', async () => { ... });
  it('returns empty mc-user role for a user without the role', async () => { ... });
});
```

**Verify RED**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="token-service.integration"
```
**Expected RED**: Tests fail — assertion mismatches against the real validated token/claims, or the real Keycloak call fails. At least 1 test failing is required before implementing any fix.

**Verify GREEN** (after confirming import paths and test logic are correct):
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="token-service.integration"
```
**Expected GREEN**: 4 tests passing. Keycloak JWKS endpoint was called; real JWT validated.

**Done when**: Tests pass against real Keycloak (SC-002).

---

### T006 — Delete login.test.ts and login-errors.test.ts

**Type**: File deletion | **Time**: 5 min | **Risk**: None

**Spec reference**: SC-001, SC-008

Delete after T005 tests pass:
- `tests/integration/login.test.ts`
- `tests/integration/login-errors.test.ts`

**Verify**:
```bash
grep -r "MockAdapter" tests/integration/ | wc -l
```
**Expected**: Count decreases by the number of `MockAdapter` references in those two files.

**Done when**: Both files deleted; `pnpm nx test:integration mcm-app` still passes.

---

## Phase 2: Session Manager Integration Tests

### T007 — Write session-manager integration tests (RED)

**Type**: New test file | **Time**: 1 hr | **Risk**: Low

**Scenarios covered**:
- US2-AC1: Session created in Redis with correct TTL
- US2-AC2: Session retrieved returns original payload
- US2-AC3: Session expires when TTL elapses
- US2-AC4: `MAX_CONCURRENT_SESSIONS` evicts oldest session
- US2-AC5: Deleted session returns null on retrieval

**File**: `frontend/mcm-app/tests/integration/session-manager.integration.test.ts`

```typescript
// Actual exports: createSession(userId), getValidSession(sessionId), terminateSession(sessionId, userId),
// terminateAllSessions(userId), getActiveSessionCount(userId), touchSession(sessionId). (No getSession/deleteSession.)
import { createSession, getValidSession, terminateSession } from '@/bff-server/session-manager';
import { redisExists, redisTtl, redisKeys, redisFlushDb, closeRedis } from './helpers/redis-test-client';

describe('session-manager — integration', () => {
  beforeAll(async () => { await redisFlushDb(); });
  afterAll(async () => { await redisFlushDb(); await closeRedis(); });
  beforeEach(async () => { await redisFlushDb(); });

  it('creates session in Redis with correct idle TTL', async () => { ... });
  it('retrieves session payload from Redis', async () => { ... });
  it('returns null for an expired session', async () => { ... });
  it('evicts oldest session when MAX_CONCURRENT_SESSIONS exceeded', async () => { ... });
  it('deleted session is absent from Redis', async () => { ... });
});
```

Note: `jest.integration.config.js` (created in T004a) sets `process.env.REDIS_URL = 'redis://localhost:6379/1'` via `setupFiles` so that `session-manager.ts`, when imported directly, connects to db 1 — the same db as `redis-test-client.ts`. See plan.md "Session Namespace Isolation".

**Verify RED**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="session-manager.integration"
```
**Expected RED**: ≥1 test failing — either import path wrong, or real Redis assertions fail (TTL value, key structure).

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="session-manager.integration"
```
**Expected GREEN**: 5 tests passing. Redis key/TTL verified by `redis-test-client` (SC-003).

**Done when**: All session-manager tests pass with real Redis assertions.

---

### T008 — Delete session-timeout.test.ts and concurrent-sessions.test.ts

**Type**: File deletion | **Time**: 5 min | **Risk**: None

Delete after T007 tests pass:
- `tests/integration/session-timeout.test.ts`
- `tests/integration/concurrent-sessions.test.ts`

**Done when**: Files deleted; integration suite still passes.

---

## Phase 3: Auth Endpoint Integration Tests

### T009 — Write auth-user integration tests (RED)

**Type**: New test file | **Time**: 30 min | **Risk**: Low

**Scenarios covered**:
- `/bff-api/auth/user` returns correct user profile from a real Redis session
- `/bff-api/auth/user` returns 401 with no session cookie
- Role-based access: user without `mc-user` role is rejected

**File**: `frontend/mcm-app/tests/integration/auth-user.integration.test.ts`

Use `keycloak-test-client.ts` to obtain a real token, manually create a Redis session, call `/bff-api/auth/user` with the session cookie, and verify the response.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="auth-user.integration"
```
**Expected RED**: ≥1 failing — session cookie not wired, or user endpoint returns unexpected data.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="auth-user.integration"
```
**Expected GREEN**: All tests passing with real session data.

**Done when**: Tests pass (SC-004 user profile aspect).

---

### T010 — Write auth-refresh integration tests (RED)

**Type**: New test file | **Time**: 45 min | **Risk**: Medium — requires real refresh token rotation

**Scenarios covered**:
- US3-AC1: Valid refresh token → Keycloak issues new tokens → Redis session updated
- US3-AC2: Already-rotated refresh token rejected → 401
- US3-AC3: No session cookie → 401

**File**: `frontend/mcm-app/tests/integration/auth-refresh.integration.test.ts`

```typescript
// Setup: create a real Redis session with a real refresh token (from ROPC)
// Call POST /bff-api/auth/refresh
// Assert: Redis session now contains different access/refresh tokens
// Assert: previous refresh token is rejected on second call
```

**Verify RED**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="auth-refresh.integration"
```
**Expected RED**: ≥1 failing — either the session structure doesn't match what the refresh endpoint expects, or the Redis update assertion fails.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="auth-refresh.integration"
```
**Expected GREEN**: All tests passing. Redis session shows new token values after refresh (SC-004).

**Done when**: Refresh tests pass with real Keycloak token rotation and Redis session update verified.

---

### T011 — Write auth-logout integration tests (RED)

**Type**: New test file | **Time**: 45 min | **Risk**: Low

**Scenarios covered**:
- US4-AC1: Logout deletes Redis session key
- US4-AC2: Logout terminates Keycloak SSO session (verified via Admin API)
- US4-AC3: No session cookie → 401

**File**: `frontend/mcm-app/tests/integration/auth-logout.integration.test.ts`

```typescript
// Setup: create a real session, get session cookie
// Call POST /bff-api/auth/logout
// Assert: redisExists(sessionKey) === false
// Assert: getUserSessions(userId).length === 0
```

**Verify RED**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="auth-logout.integration"
```
**Expected RED**: ≥1 failing — Keycloak session not terminated (constitution violation if this passes trivially).

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="auth-logout.integration"
```
**Expected GREEN**: All tests passing. Both Redis and Keycloak session confirmed cleared (SC-005).

**Done when**: Logout tests verify both Redis deletion and Keycloak SSO termination.

---

### T012 — Delete profile-access.test.ts, logout.test.ts, token-refresh.test.ts, unauthorized-access.test.ts, role-based-access.test.ts

**Type**: File deletion | **Time**: 5 min | **Risk**: None

Delete after T009–T011 pass:
- `tests/integration/profile-access.test.ts`
- `tests/integration/logout.test.ts`
- `tests/integration/token-refresh.test.ts`
- `tests/integration/unauthorized-access.test.ts`
- `tests/integration/role-based-access.test.ts`

**Done when**: Files deleted; `pnpm nx test:integration mcm-app` passes.

---

## Phase 4: Registration Integration Tests

### T013 — Write auth-register integration tests (RED)

**Type**: New test file | **Time**: 1 hr | **Risk**: Medium — creates real Keycloak users

**Scenarios covered**:
- US5-AC1: Valid registration creates Keycloak user with `mc-user` role and pending email verification
- US5-AC2: Duplicate username returns 409; no duplicate user created
- US5-AC3: Password failing Keycloak policy returns 400

**File**: `frontend/mcm-app/tests/integration/auth-register.integration.test.ts`

```typescript
// Setup: generate a unique username for this test run
// Call POST /bff-api/auth/register with valid credentials
// Assert via Admin API: user exists, has mc-user role, emailVerified=false
// Cleanup: deleteTestUser(userId) in afterAll

// Separate test: register same username twice → 409
// Separate test: register with weak password → 400
```

**Verify RED**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="auth-register.integration"
```
**Expected RED**: ≥1 failing — Admin API verification shows missing role, or duplicate test doesn't return 409.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="auth-register.integration"
```
**Expected GREEN**: All tests passing. Keycloak user verified via Admin API; cleanup confirmed (SC-006).

**Done when**: Registration tests create and verify real Keycloak users; test users deleted in `afterAll`.

---

### T014 — Delete register.test.ts and email-verification.test.ts

**Type**: File deletion | **Time**: 5 min | **Risk**: None

Delete after T013 passes:
- `tests/integration/register.test.ts`
- `tests/integration/email-verification.test.ts`

**Done when**: Files deleted; suite passes.

---

## Phase 5: Rate Limiter Integration Tests

### T015 — Write rate-limiter integration tests (RED)

**Type**: New test file | **Time**: 45 min | **Risk**: Low

**Scenarios covered**:
- US6-AC1: Requests exceeding the rate limit return 429; Redis counter key exists with non-zero TTL
- US6-AC2: After TTL expiry, requests are accepted again

**File**: `frontend/mcm-app/tests/integration/rate-limiter.integration.test.ts`

```typescript
// Import rate-limiter.ts directly (connects to db 1 via REDIS_URL override in jest.integration.config.js — T004a)
// OR: call /bff-api/auth/login in a loop until 429 is triggered
// Assert: redisExists(rateLimitKey) === true
// Assert: redisTtl(rateLimitKey) > 0

// Second test: mock time advancement (or wait for short TTL) → request accepted
```

Note: If testing via the HTTP login endpoint, use a test-specific IP address header (`X-Forwarded-For`) to avoid polluting the development rate limit state.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="rate-limiter.integration"
```
**Expected RED**: ≥1 failing — rate limit key not found in Redis, or TTL assertion fails.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app -- --testPathPattern="rate-limiter.integration"
```
**Expected GREEN**: All tests passing. Redis counter key confirmed with TTL (SC-007).

**Done when**: Rate limit tests verify real Redis state.

---

### T016 — Delete error-messages.test.ts

**Type**: File deletion | **Time**: 5 min | **Risk**: None

Delete after T015 passes:
- `tests/integration/error-messages.test.ts`

**Done when**: File deleted; suite passes.

---

## Phase 6: Final Cleanup and Verification

### T017 — Verify zero MockAdapter references and full suite passes

**Type**: Verification + Cleanup | **Time**: 30 min | **Risk**: None

**Steps:**

1. Confirm no `MockAdapter` imports remain:
   ```bash
   grep -r "MockAdapter\|axios-mock-adapter" tests/integration/
   ```
   **Expected**: No output (SC-008).

2. Confirm all 12 original files are deleted:
   ```bash
   ls tests/integration/*.test.ts | grep -v "\.integration\."
   ```
   **Expected**: No output.

3. Run full integration suite:
   ```bash
   pnpm nx test:integration mcm-app
   ```
   **Expected GREEN**: All tests pass (SC-001, SC-009).

4. Verify `rtk gain` shows >80%:
   ```bash
   rtk gain
   ```

**Done when**: All success criteria from spec.md are satisfied.

---

## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1: Real JWT validation | N/A — integration test; no web/mobile UI distinction | N/A — integration test; no web/mobile UI distinction | N/A |
| US2: Real session management | N/A — integration test; no web/mobile UI distinction | N/A — integration test; no web/mobile UI distinction | N/A |
| US3: Real token refresh | N/A — integration test; no web/mobile UI distinction | N/A — integration test; no web/mobile UI distinction | N/A |
| US4: Real logout | N/A — integration test; no web/mobile UI distinction | N/A — integration test; no web/mobile UI distinction | N/A |
| US5: Real registration | N/A — integration test; no web/mobile UI distinction | N/A — integration test; no web/mobile UI distinction | N/A |
| US6: Real rate limiting | N/A — integration test; no web/mobile UI distinction | N/A — integration test; no web/mobile UI distinction | N/A |

All rows are N/A: integration tests exercise BFF server-side modules and HTTP endpoints directly. Platform parity (web vs mobile client) is covered by feature 001 and 002 E2E tests, not by BFF integration tests.

---

## Completion Checklist

Before marking `004-bff-integration-tests` complete, verify all success criteria from [spec.md](spec.md):

- [ ] **SC-001**: `pnpm nx test:integration mcm-app` passes with zero uses of `axios-mock-adapter`
- [ ] **SC-002**: `token-service.ts` tests validate a real Keycloak JWT against live JWKS; invalid tokens correctly rejected
- [ ] **SC-003**: `session-manager.ts` tests create, read, and expire sessions in real Redis; TTL and eviction verified by direct Redis inspection
- [ ] **SC-004**: `/bff-api/auth/refresh` test uses a real refresh token and verifies Redis session is updated with new tokens
- [ ] **SC-005**: `/bff-api/auth/logout` test verifies both Redis session deletion and Keycloak SSO session termination
- [ ] **SC-006**: `/bff-api/auth/register` test creates a real Keycloak user with correct role; user deleted in `afterAll`
- [ ] **SC-007**: Rate limiter test verifies 429 returned after real Redis counter reaches threshold
- [ ] **SC-008**: `grep -r "MockAdapter" tests/integration/` returns no output
- [ ] **SC-009**: All integration tests pass with Keycloak and Redis running
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `pnpm nx test mcm-app` — unit tests still pass (≥70% line coverage unaffected)
- [ ] `rtk gain` — >80% token compression confirmed (run last)
