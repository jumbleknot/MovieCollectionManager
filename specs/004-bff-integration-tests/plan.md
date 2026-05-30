# Implementation Plan: BFF Integration Test Replacement

**Branch**: `004-bff-integration-tests` | **Date**: 2026-05-30 | **Spec**: [spec.md](spec.md)

---

## Summary

Delete all 12 existing `tests/integration/*.test.ts` files (which use `axios-mock-adapter` and test nothing real) and replace them with genuine integration tests that run against a live Keycloak instance and a live Redis instance. Add a dedicated ROPC test client to Keycloak, add two test helpers (ROPC token acquisition, Redis inspection), and rewrite tests module by module. No BFF production code is changed.

---

## Technical Context

**Language/Version**: TypeScript 5.x (Jest, Axios, ioredis)

**Primary Dependencies** (all already installed):
- Jest — test runner via `pnpm nx test:integration mcm-app`
- Axios — HTTP client for BFF endpoint calls in tests
- `ioredis` — direct Redis inspection in test assertions (already in BFF production deps)
- `@keycloak/keycloak-admin-client` — Keycloak Admin API for test user setup/teardown (already used by BFF)

**New npm dependencies**: None. All required libraries are already in `package.json`.

**Keycloak Configuration Change** (required, non-code):
- Create client `mcm-bff-test` in `jumbleknot` realm
- Enable Direct Access Grants on `mcm-bff-test`
- Add `mcm-bff-test` client credentials to `.env.e2e.local` (gitignored)
- Document setup in quickstart.md

**Files Deleted** (all 12 existing integration test files):
- `tests/integration/login.test.ts`
- `tests/integration/logout.test.ts`
- `tests/integration/token-refresh.test.ts`
- `tests/integration/session-timeout.test.ts`
- `tests/integration/register.test.ts`
- `tests/integration/email-verification.test.ts`
- `tests/integration/concurrent-sessions.test.ts`
- `tests/integration/profile-access.test.ts`
- `tests/integration/role-based-access.test.ts`
- `tests/integration/login-errors.test.ts`
- `tests/integration/error-messages.test.ts`
- `tests/integration/unauthorized-access.test.ts`

**Files Created** (new):
- `tests/integration/helpers/keycloak-test-client.ts` — ROPC token acquisition + test user lifecycle
- `tests/integration/helpers/redis-test-client.ts` — direct Redis key/value/TTL inspection
- `tests/integration/helpers/bff-test-server.ts` — axios instance pointed at the running BFF
- `tests/integration/token-service.integration.test.ts` — JWT validation against real Keycloak JWKS
- `tests/integration/session-manager.integration.test.ts` — session CRUD against real Redis
- `tests/integration/auth-refresh.integration.test.ts` — refresh endpoint with real Keycloak + Redis
- `tests/integration/auth-logout.integration.test.ts` — logout endpoint with real Redis + Keycloak Admin API
- `tests/integration/auth-register.integration.test.ts` — registration with real Keycloak Admin API
- `tests/integration/auth-user.integration.test.ts` — user endpoint with real session
- `tests/integration/rate-limiter.integration.test.ts` — rate limiting against real Redis

**No production source files are modified.**

---

## Constitution Check

| Principle | Status | Notes |
|---|---|---|
| TDD: tests written and verified RED before implementation | ✅ Pass | All test files verified RED before any helper/config work |
| No runtime patches: tests fail if the feature is broken | ✅ Pass | No MockAdapter; tests call real services |
| Independent state: tests reset environment | ✅ Pass | `afterAll` deletes test users; `beforeEach` resets Redis keys |
| Consistent E2E across clients | N/A | This feature is integration tests, not E2E |
| AI Assistant must not vibe-code | ✅ Pass | Every task references spec.md and plan.md |

---

## Architecture

### Test Helper Design

```
tests/integration/helpers/
├── keycloak-test-client.ts   — ROPC token acquisition; test user create/delete
├── redis-test-client.ts      — direct Redis inspection (key, value, TTL)
└── bff-test-server.ts        — pre-configured axios instance for BFF calls
```

#### keycloak-test-client.ts

```typescript
// Wraps ROPC grant + Admin API for test setup
export async function getTestTokens(username: string, password: string): Promise<{
  accessToken: string;
  refreshToken: string;
  idToken: string;
}>;

export async function createTestUser(username: string, password: string): Promise<string>; // returns userId
export async function deleteTestUser(userId: string): Promise<void>;
export async function getUserSessions(userId: string): Promise<KeycloakSession[]>;
```

ROPC token endpoint:
```
POST http://localhost:8099/realms/jumbleknot/protocol/openid-connect/token
  grant_type=password
  client_id=mcm-bff-test
  client_secret=<test-client-secret>
  username=<test-user>
  password=<test-password>
  scope=openid
```

#### redis-test-client.ts

```typescript
// Direct Redis inspection using ioredis (separate connection from BFF)
export async function redisGet(key: string): Promise<string | null>;
export async function redisTtl(key: string): Promise<number>; // -2 = key not found, -1 = no TTL
export async function redisExists(key: string): Promise<boolean>;
export async function redisDel(key: string): Promise<void>;
export async function redisKeys(pattern: string): Promise<string[]>;
```

#### bff-test-server.ts

```typescript
// Axios instance targeting the running BFF; handles cookie jar
export const bff = axios.create({
  baseURL: 'http://localhost:8081',
  withCredentials: true,
});
```

### Test User Lifecycle

```
beforeAll:
  1. createTestUser('int-test-user', process.env.E2E_TEST_PASSWORD)
  2. getTestTokens('int-test-user', ...) → save accessToken, refreshToken

afterAll:
  1. deleteTestUser(userId)
```

Each test suite creates its own test user with a unique username prefix (e.g., `int-token-`, `int-session-`) to allow parallel suite execution without collision.

### PKCE Code Exchange — Explicitly Out of Scope

The `keycloak.exchangeCode(code, codeVerifier)` function in `src/bff-server/keycloak.ts` requires a one-time authorization code from a browser-initiated PKCE flow. This step cannot be automated without a browser. It is covered by:

1. **Feature 003 Playwright global setup** — goes through the full OIDC flow on every E2E test run
2. **Feature 001 E2E auth tests** — `auth.spec.ts` tests the login screen → Keycloak → redirect → session flow

Every integration test file that would logically test the login endpoint must include a comment:
```typescript
// NOTE: The PKCE code exchange step (keycloak.exchangeCode) is out of scope for
// integration tests. It is covered by the Playwright global setup in feature 003.
// Integration tests begin after token acquisition: session creation onward.
```

### Session Namespace Isolation

Integration tests use Redis database index 1; the running development BFF uses db 0. This prevents test sessions from appearing in development and keeps assertions clean.

**Mechanism**: `jest.integration.config.ts` (or its `globalSetup` / `setupFiles` entry) sets `process.env.REDIS_URL = 'redis://localhost:6379/1'` before any test modules are loaded. Because `session-manager.ts` and `rate-limiter.ts` read `REDIS_URL` at module initialisation, they connect to db 1 when imported in test scope. `redis-test-client.ts` hardcodes `db: 1` so both the module under test and the inspection helper operate on the same database. No production source file is modified.

Add `REDIS_TEST_DB=1` to `.env.e2e.local` as documentation of the convention; the Jest config is the enforcement point.

### Module-Level vs HTTP-Level Tests

| Test file | What it tests | Level |
|---|---|---|
| `token-service.integration.test.ts` | Import `token-service.ts` directly; call validation functions | Module-level |
| `session-manager.integration.test.ts` | Import `session-manager.ts` directly; inspect Redis via helper | Module-level |
| `auth-refresh.integration.test.ts` | HTTP POST to `/bff-api/auth/refresh` via `bff-test-server.ts` | HTTP-level |
| `auth-logout.integration.test.ts` | HTTP POST to `/bff-api/auth/logout` via `bff-test-server.ts` | HTTP-level |
| `auth-register.integration.test.ts` | HTTP POST to `/bff-api/auth/register` via `bff-test-server.ts` | HTTP-level |
| `auth-user.integration.test.ts` | HTTP GET to `/bff-api/auth/user` via `bff-test-server.ts` | HTTP-level |
| `rate-limiter.integration.test.ts` | Import `rate-limiter.ts` directly; inspect Redis counter keys | Module-level |

**Module-level tests** import BFF source modules directly and call their functions, bypassing the HTTP layer. They are faster and more focused but require the module's dependencies (Redis, Keycloak JWKS) to be running.

**HTTP-level tests** make real HTTP requests to the running BFF server via `bff-test-server.ts`. They test the full request path including middleware, cookie handling, and response serialization.

---

## Implementation Phases

### Phase 0: Keycloak + Test Infrastructure (2 hrs)

Configure the ROPC test client in Keycloak and write the three test helpers. All subsequent phases depend on this.

Tasks: T001–T004

### Phase 1: Token Service Integration Tests (1 hr)

Replace `login.test.ts` and `login-errors.test.ts` coverage of JWT validation with real token tests.

Tasks: T005–T006

### Phase 2: Session Manager Integration Tests (1.5 hrs)

Replace `session-timeout.test.ts` and `concurrent-sessions.test.ts` with real Redis tests.

Tasks: T007–T008

### Phase 3: Auth Endpoint Integration Tests — Refresh, User, Logout (2 hrs)

Replace `token-refresh.test.ts`, `profile-access.test.ts`, `logout.test.ts`, `unauthorized-access.test.ts`, and `role-based-access.test.ts` with HTTP-level tests using real sessions.

Tasks: T009–T012

### Phase 4: Registration Integration Tests (2 hrs)

Replace `register.test.ts` and `email-verification.test.ts` with Keycloak Admin API tests.

Tasks: T013–T014

### Phase 5: Rate Limiter Integration Tests (1 hr)

Replace the rate-limit cases in `error-messages.test.ts` and `login.test.ts` with real Redis counter tests.

Tasks: T015–T016

### Phase 6: Cleanup and Verification (30 min)

Delete all 12 original files. Verify `axios-mock-adapter` has zero references in `tests/integration/`. Run the full integration suite.

Tasks: T017

---

## Non-Obvious Design Decisions

- **ROPC client is separate from the production client**: `mcm-bff-test` is a distinct Keycloak client with Direct Access Grants enabled. The production `movie-collection-manager` client must never have this grant. This ensures the test-only credential path cannot be used in production.
- **Module-level tests import BFF source directly**: Rather than going through HTTP for every test, module-level tests import `session-manager.ts` and `token-service.ts` directly. This gives cleaner error messages and avoids the overhead of starting the full HTTP request pipeline for tests that don't need it.
- **Redis database index isolation via Jest env override**: `jest.integration.config.ts` sets `REDIS_URL=redis://localhost:6379/1` before modules load. This ensures `session-manager.ts` and `rate-limiter.ts`, when imported directly in test scope, connect to db 1 — the same db as `redis-test-client.ts`. Without this, module-level tests would write to db 0 while the helper reads db 1, causing all key-existence assertions to fail. The running BFF (db 0) is unaffected.
- **Test users are created fresh per suite, not shared**: Each test file's `beforeAll` creates its own unique test user (e.g., `int-session-user`, `int-refresh-user`). This allows test files to run in any order and prevents a failed teardown in one suite from breaking another.
- **afterAll cleanup is best-effort for users, mandatory for Redis**: If `deleteTestUser` fails (e.g., user was already deleted by a previous test), `afterAll` should log a warning but not fail the suite. Redis keys created by tests should use short TTLs (60 seconds) as a safety net even if `redisDel` is called explicitly.
- **Orphaned integration test user cleanup**: If a suite's `afterAll` crashes before calling `deleteTestUser`, users prefixed with `int-` accumulate in Keycloak. The `scripts/cleanup-e2e-data.ts` script (introduced in feature 003 to clean up E2E test data) should be extended to also delete Keycloak users matching the `int-*` prefix. This is a best-effort safety net — it does not change the per-suite `afterAll` obligation.
