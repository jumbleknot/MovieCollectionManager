import { defineConfig, devices } from '@playwright/test';
import * as os from 'node:os';

// 052 US3: the upper bound on Playwright workers, and therefore on concurrent BFF sessions for the
// shared E2E user — one session per worker is what keeps them off each other's refresh bucket.
//
// SIX, not eight, and the difference is measured. A local smoke run with the bound at 8 reported
// `session_evicted=8`: the eight fresh sessions plus what the user already held crossed
// MAX_CONCURRENT_SESSIONS (10) and `createSession` began evicting. CI starts from a wiped Redis so 8
// would *just* fit — 8 here plus one for the `lifecycle` project's real login is 9 of 10 — but that
// is precisely the "sits right at the edge" fragility this feature exists to remove, and shipping at
// 9/10 would re-create the eviction hazard that run 1605 refuted.
//
// The refresh contention is fixed by the per-worker SESSION, not by this number; the bound exists
// only to keep the session count clear of the cap. Cost is wall-clock (~21 min → ~28 min for the web
// suite), well inside the job's 75-minute budget.
const MAX_E2E_WORKERS = 6;
const E2E_WORKERS = Math.max(1, Math.min(MAX_E2E_WORKERS, Math.floor(os.cpus().length / 2)));

// Feature 007: target the BFF Docker container instead of Metro for the FINAL E2E run.
//   E2E_BFF_TARGET unset        → Metro dev server on :8081 (default; iterative dev).
//   E2E_BFF_TARGET=dev-container → dev-config container on http://localhost:8082 (US1).
//   E2E_BFF_TARGET=prod-container → prod container behind TLS on https://localhost:8443 (US3).
// For a container target we set baseURL accordingly and do NOT auto-start Metro (the
// container already serves the app + BFF); prod additionally ignores the self-signed cert.
const TARGET = process.env['E2E_BFF_TARGET'];
const CONTAINER_BASE_URL =
  TARGET === 'dev-container' ? 'http://localhost:8082'
  : TARGET === 'prod-container' ? 'https://localhost:8443'
  : null;
const baseURL = CONTAINER_BASE_URL ?? 'http://localhost:8081';

export default defineConfig({
  testDir: './tests/e2e/web',
  // T008/T009: authenticate once + seed the fixture before any test (FR-004, FR-005, SC-001).
  globalSetup: './tests/e2e/web/setup/global-setup.ts',
  timeout: 90000,   // 90 s: ~15-20 s login (popup + BFF + collections) + 60-70 s test body
  expect: { timeout: 10000 },
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  // 052 US3 — BOUNDED, not reduced. Playwright's default (half the cores) already gave 8 on the kvm
  // runner, so CI behaviour is unchanged; the cap only bites on a bigger host.
  //
  // It has to be bounded because the worker count is now also the SESSION count: each worker holds
  // its own BFF session (tests/e2e/web/fixtures/worker-session.ts) so that no two share a refresh
  // rate-limit bucket. MAX_CONCURRENT_SESSIONS is 10, and the default on this 20-core dev container
  // would be 10 — which reaches the cap and makes `createSession` evict, swapping the contention this
  // feature fixed for the eviction it refuted. scripts/__tests__/e2e-worker-session.test.mjs asserts
  // the headroom against env.ts.
  workers: E2E_WORKERS,
  retries: 1,  // SSO timing races between parallel workers cause intermittent login timeouts
  // 'dot' = one char per test; combined with RTK keeps a passing run to a compact summary (T005, FR-002)
  reporter: 'dot',
  use: {
    baseURL,
    // React Native Web renders testID as data-testid
    testIdAttribute: 'data-testid',
    headless: true,
    // prod-container is served over a self-signed TLS endpoint (Caddy) — trust it for the run.
    ignoreHTTPSErrors: TARGET === 'prod-container',
    // T009: every test inherits the session saved by global setup; no per-test login.
    // auth.spec.ts opts out via test.use({ storageState: { cookies: [], origins: [] } }).
    storageState: './tests/e2e/web/setup/.auth/user.json',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // T013: the prod-lifecycle spec performs a REAL logout, which terminates the test user's
      // Keycloak SSO session — that would break token refresh for the shared global-setup session
      // the rest of the suite relies on. Keep it out of the main project…
      //
      // 040 T032: admin-registration.spec.ts is the same hazard class — it toggles the APPLICATION-WIDE
      // self-registration setting (a single global Mongo doc the running BFF reads), so while it runs
      // with registration OFF any parallel spec that exercises the real /register would see a 403 that
      // has nothing to do with its own subject. Isolate it the same way rather than relying on the
      // fact that auth.spec.ts happens to mock that route today.
      testIgnore: /(bff-prod-lifecycle|admin-registration)\.spec\.ts/,
    },
    {
      // …and run them as a DEPENDENT project so they execute strictly AFTER the main suite finishes,
      // where the logout / the global registration toggle can no longer poison the other specs. Each
      // owns an isolated session and does not consume the shared one: bff-prod-lifecycle via
      // `test.use({ storageState: empty })`; admin-registration mints its own throwaway mc-admin and
      // an anonymous visitor via `browser.newContext(...)` — it needs TWO identities at once (admin +
      // non-admin), which file-level `test.use` cannot express.
      name: 'lifecycle',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /(bff-prod-lifecycle|admin-registration)\.spec\.ts/,
      dependencies: ['chromium'],
    },
  ],
  // Only auto-start Metro for the default (Metro) target. When targeting a container the
  // operator deploys it first (docker compose --profile bff-dev/bff-prod up -d), so Playwright
  // must NOT spawn Metro (it would occupy :8081 and could mask the container).
  ...(CONTAINER_BASE_URL
    ? {}
    : {
        webServer: {
          // CI=1 replaces the removed --non-interactive flag in Expo 55+
          command: 'pnpm exec expo start --web',
          url: 'http://localhost:8081',
          reuseExistingServer: !process.env['CI'],
          timeout: 120000,
          env: { CI: '1' },
        },
      }),
});
