import { defineConfig, devices } from '@playwright/test';

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
    baseURL: 'http://localhost:8081',
    // React Native Web renders testID as data-testid
    testIdAttribute: 'data-testid',
    headless: true,
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
  webServer: {
    // CI=1 replaces the removed --non-interactive flag in Expo 55+
    command: 'pnpm exec expo start --web',
    url: 'http://localhost:8081',
    reuseExistingServer: !process.env['CI'],
    timeout: 120000,
    env: { CI: '1' },
  },
});
