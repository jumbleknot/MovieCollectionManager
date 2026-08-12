import { defineConfig, devices } from '@playwright/test';
import * as os from 'node:os';

// The upper bound on Playwright workers.
//
// HISTORY, because the number has been wrong in both directions. Feature 052 set it to SIX to keep
// the SHARED E2E user's session count clear of MAX_CONCURRENT_SESSIONS (10): all workers acted as one
// user, so workers == sessions-for-that-user, and a local smoke run at 8 measured `session_evicted=8`.
// The cost was wall clock — this file recorded ~21 min → ~28 min for the web suite on that change.
//
// 054 US4 removed the reason. `MAX_CONCURRENT_SESSIONS` is PER USER, and each worker is now its own
// user holding exactly one session, so the cap cannot be approached however many workers run.
// Measured after that change: `session_evicted=0` locally and in CI (app-ci run #1681). Raised to 10.
//
// What still bounds it: the machine (half the cores), and the LOGIN rate limit — `/bff-api/auth/login`
// allows 5 per 60 s per IP and global setup logs in once per worker, sequentially, at ~15 s each,
// about 4 per minute. That holds at 10; it would NOT hold if those logins were made concurrent.
const MAX_E2E_WORKERS = 10;
const E2E_WORKERS = Math.max(1, Math.min(MAX_E2E_WORKERS, Math.floor(os.cpus().length / 2)));

// SELF-REPORTING, because the cap and the core count are indistinguishable from the outside: a run
// printing "using 8 workers" could be capped at 8 or running on a 16-core box, and only one of those
// is worth changing. Measured once and then guessed at is how the old bound outlived its reason.
// (It answered the question on run #1684: `cores=16 maxWorkers=10 → workers=8`, so the machine binds
// and the cap does not — going past 8 means changing the divisor, not the ceiling.)
//
// ONCE, not once per worker. Playwright evaluates this config in the main process AND in every
// worker process, so the first version printed the line ten times into the step log the failure
// digest carries. `TEST_WORKER_INDEX` is set only in workers, which is the cheapest way to tell them
// apart. A diagnostic that floods the channel it reports through is a diagnostic people learn to
// scroll past.
if (process.env['TEST_WORKER_INDEX'] === undefined) {
  console.log(`[playwright] cores=${os.cpus().length} maxWorkers=${MAX_E2E_WORKERS} → workers=${E2E_WORKERS}`);
}

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

// 056 (item #170) — which tier this invocation runs.
//
//   E2E_TIER=gate   everything EXCEPT @model-decision — the blocking merge gate
//   E2E_TIER=model  ONLY @model-decision — non-blocking, runs on main/dispatch
//   unset           everything (local default, unchanged)
//
// IN THE CONFIG, NOT ON THE CLI, and that is not a style preference. MEASURED 2026-08-12 on
// Playwright 1.60: `--grep-invert` is accepted and DOES NOTHING here — `--grep CORS` lists 1 test
// while `--grep-invert CORS` lists all 177. A workflow built on the CLI flag would have run the whole
// suite in the "gate" selection and the split would have been a silent no-op that looked correct.
// `grepInvert` in the config is applied by the runner itself and is asserted by
// scripts/__tests__/agent-test-classification.test.mjs.
const TIER = process.env['E2E_TIER'];
const MODEL_DECISION = /@model-decision/;

export default defineConfig({
  testDir: './tests/e2e/web',
  ...(TIER === 'gate' ? { grepInvert: MODEL_DECISION } : {}),
  ...(TIER === 'model' ? { grep: MODEL_DECISION } : {}),
  // T008/T009: authenticate once + seed the fixture before any test (FR-004, FR-005, SC-001).
  globalSetup: './tests/e2e/web/setup/global-setup.ts',
  // 054 US6: fail a LOCAL run whose auth was being rate-limited, naming the token lifespan rather
  // than letting it surface as `gotoHome: home screen did not render` — a message that names a cause
  // it never tested. No-ops under CI, where the host-side contention gate already measures this and
  // the Playwright container has no Docker CLI.
  globalTeardown: './tests/e2e/web/setup/global-teardown.ts',
  timeout: 90000,   // 90 s: ~15-20 s login (popup + BFF + collections) + 60-70 s test body
  expect: { timeout: 10000 },
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  // Bounded by the machine and the login rate limit — see MAX_E2E_WORKERS above.
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
