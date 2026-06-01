import { defineConfig, devices } from '@playwright/test';

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
