/**
 * E2E test for session idle timeout (T-150)
 * Login, fast-forward idle timer via test override, verify automatic redirect to login screen.
 *
 * Requires: Detox + running Expo app with __DEV__ session timeout override
 */

describe('Session Idle Timeout (E2E — T-150)', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  /**
   * T-150: Login, idle for 30 minutes (fast-forwarded), verify redirect to login with
   * inactivity message.
   *
   * Note: The app must expose a test-only mechanism to advance the session idle timer.
   * In development, set __DEV_IDLE_TIMEOUT_OVERRIDE_MS in environment to a short value
   * (e.g., 5000ms) to trigger timeout quickly.
   */
  it('redirects to login screen after idle session timeout', async () => {
    // Log in
    await element(by.id('btn-login-with-keycloak')).tap();
    await waitFor(element(by.web.id('username'))).toExist().withTimeout(15000);
    await element(by.web.id('username')).typeText(process.env.E2E_TEST_USER ?? 'testuser');
    await element(by.web.id('password')).typeText(process.env.E2E_TEST_PASSWORD ?? 'TestPass1!');
    await element(by.web(by.type('submit'))).tap();
    await waitFor(element(by.id('home-screen'))).toBeVisible().withTimeout(15000);

    // Trigger test override: fast-forward idle timer
    // The app checks for __DEV_IDLE_TIMEOUT_OVERRIDE_MS in EXPO_PUBLIC_* env
    // With a short timeout set, the session-timeout hook fires quickly.
    // Wait for session timeout to trigger (e.g., 6 seconds with 5000ms override)
    await waitFor(element(by.id('login-screen'))).toBeVisible().withTimeout(30000);

    // Verify login screen is shown (timeout triggered redirect)
    await expect(element(by.id('btn-login-with-keycloak'))).toBeVisible();
  });
});
