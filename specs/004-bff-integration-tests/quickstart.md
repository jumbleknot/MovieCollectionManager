# Quickstart: BFF Integration Test Replacement (004-bff-integration-tests)

**Branch**: `004-bff-integration-tests` | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Tasks**: [tasks.md](tasks.md)

---

## What this feature delivers

Replaces all 12 existing `tests/integration/*.test.ts` files, which use `axios-mock-adapter` to mock responses and never call any real service, with genuine integration tests that run against a live Keycloak instance and a live Redis instance. When complete:

- `session-manager.ts` is tested against real Redis: TTL, eviction, and expiry verified by direct key inspection
- `token-service.ts` is tested against the real Keycloak JWKS endpoint: real JWT validation, not hardcoded fixtures
- The `/bff-api/auth/refresh`, `/bff-api/auth/logout`, `/bff-api/auth/register`, and `/bff-api/auth/user` endpoints are tested with real sessions and real Keycloak calls
- The rate limiter is tested against real Redis counters
- `axios-mock-adapter` has zero references in `tests/integration/`

No production BFF code is changed.

---

## Prerequisites

### 0. Feature 003 complete (mandatory)

Feature `003-test-hardening` must be merged before starting this branch. The PKCE code exchange step in `keycloak.exchangeCode()` is intentionally out of scope for integration tests — it is covered by the Playwright global setup established in feature 003. Without feature 003's `global-setup.ts`, that coverage gap would be unaddressed.

### 1. Stack running (mandatory)

Integration tests require Keycloak and Redis:

```bash
pnpm nx up-keycloak infrastructure-as-code  # starts Keycloak + Redis + MongoDB
```

The BFF Expo server must be running for HTTP-level endpoint tests:

```bash
cd frontend/mcm-app && CI=1 pnpm exec expo start --web --port 8081
```

### 2. RTK active

```bash
rtk init --global
```

### 3. One-time Keycloak setup (T001)

Create the ROPC test client in the Keycloak Admin UI:

1. Navigate to `http://localhost:8099` → `jumbleknot` realm → Clients → Create
2. Client ID: `mcm-bff-test`
3. Client Authentication: **On** (Confidential)
4. Authentication Flow: enable **Direct Access Grants** only
5. Save; go to Credentials tab → copy the generated secret
6. Add to `frontend/mcm-app/.env.e2e.local`:
   ```
   E2E_ROPC_CLIENT_ID=mcm-bff-test
   E2E_ROPC_CLIENT_SECRET=<paste secret here>
   ```

Verify it works:
```bash
source frontend/mcm-app/.env.e2e.local
curl -s -X POST http://localhost:8099/realms/jumbleknot/protocol/openid-connect/token \
  -d "grant_type=password&client_id=$E2E_ROPC_CLIENT_ID&client_secret=$E2E_ROPC_CLIENT_SECRET&username=$E2E_TEST_USER&password=$E2E_TEST_PASSWORD&scope=openid" \
  | jq .access_token
```
**Expected**: A non-null JWT string.

---

## Execution order

### Phase 0 — Infrastructure (2 hrs)

```
T001  Create mcm-bff-test Keycloak client  (manual — Keycloak Admin UI)
T002  Create keycloak-test-client.ts helper  (raw fetch — no admin-client lib)
T003  Create redis-test-client.ts helper      (db 1)
T004  Create bff-test-server.ts helper        (manual cookie capture — no cookie-jar lib)
T004a Create jest.integration.config.js (Node env + REDIS_URL db-1) + wire target; exclude tests/integration from unit
```

Do all five before writing any test files. T002–T004a are the foundation every test suite uses; T004a is what makes the db-1 isolation and Node environment actually take effect.

### Phase 1 — Token Service (1 hr)

```
T005  Write token-service.integration.test.ts
T006  Delete login.test.ts, login-errors.test.ts
```

### Phase 2 — Session Manager (1.5 hrs)

```
T007  Write session-manager.integration.test.ts
T008  Delete session-timeout.test.ts, concurrent-sessions.test.ts
```

### Phase 3 — Auth Endpoints: User, Refresh, Logout (2 hrs)

```
T009  Write auth-user.integration.test.ts
T010  Write auth-refresh.integration.test.ts
T011  Write auth-logout.integration.test.ts
T012  Delete profile-access, logout, token-refresh, unauthorized-access, role-based-access test files
```

### Phase 4 — Registration (2 hrs)

```
T013  Write auth-register.integration.test.ts
T014  Delete register.test.ts, email-verification.test.ts
```

### Phase 5 — Rate Limiter (1 hr)

```
T015  Write rate-limiter.integration.test.ts
T016  Delete error-messages.test.ts
```

### Phase 6 — Final Verification (30 min)

```
T017  Verify zero MockAdapter references; full suite passes
```

---

## Running the integration suite

```bash
# Full integration suite
pnpm nx test:integration mcm-app

# Single test file (during development)
pnpm nx test:integration mcm-app -- --testPathPattern="session-manager.integration"

# Verify no MockAdapter remains
grep -r "MockAdapter\|axios-mock-adapter" tests/integration/
```

---

## Key design decisions to remember

- **ROPC client is test-only**: `mcm-bff-test` has Direct Access Grants enabled. The production `movie-collection-manager` client must never have this grant. Never use the ROPC helper in production code.
- **Redis db 1 isolation**: Test helpers connect to Redis database index 1. The running BFF uses db 0. This prevents test sessions from appearing in development.
- **PKCE code exchange is intentionally out of scope**: `keycloak.exchangeCode()` requires a browser-initiated PKCE flow. It is covered by the Playwright global setup (feature 003). Every integration test file that would logically cover the login endpoint must include this comment:
  ```typescript
  // NOTE: The PKCE code exchange step (keycloak.exchangeCode) is out of scope.
  // Covered by the Playwright global setup in feature 003.
  ```
- **Each test suite creates its own user**: `beforeAll` creates a unique test user (e.g., `int-session-abc123`); `afterAll` deletes it. Test users must not be shared across suites — parallel execution would cause collisions.
- **afterAll cleanup is best-effort for Keycloak, mandatory for Redis**: If `deleteTestUser` fails (user already deleted), log a warning but don't fail the suite. Redis keys use short TTLs as a safety net even when `redisDel` is called.
- **Orphaned integration test users**: If a suite's `afterAll` crashes before calling `deleteTestUser`, users prefixed with `int-` accumulate in Keycloak. Clean them up manually via the Keycloak Admin UI (`http://localhost:8099`) or by running: `cd frontend/mcm-app && npx ts-node scripts/cleanup-e2e-data.ts` (the feature 003 cleanup script — extend it to cover `int-` prefix users if needed).
- **Delete before you add nothing new**: The existing test files are actively harmful — they give false confidence. Delete each original file immediately after the replacement passes. Do not leave both in place.
