import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e/web',
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8081',
    // React Native Web renders testID as data-testid
    testIdAttribute: 'data-testid',
    headless: true,
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
