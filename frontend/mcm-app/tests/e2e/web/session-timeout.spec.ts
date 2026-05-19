import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://localhost:8081';

const MOCK_USER = {
  id: 'user-123',
  username: 'testuser',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  roles: ['mc-user'],
  emailVerified: true,
  accountStatus: 'active',
  createdAt: '2024-01-01T00:00:00.000Z',
};

async function mockUserAuthenticated(page: Page): Promise<void> {
  await page.route('**/bff-api/auth/user', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_USER) }),
  );
}

// ─── Session idle timeout ──────────────────────────────────────────────────────

test.describe('Session idle timeout', () => {
  /**
   * T-150: After idle session timeout the user is redirected to the login screen.
   *
   * Uses Playwright's fake clock (page.clock) to fast-forward time past the 30-minute
   * idle timeout without waiting in real time. The hook uses setTimeout/setInterval
   * internally, which the fake clock intercepts.
   */
  test('redirects to login screen after idle session timeout', async ({ page }) => {
    // Install fake clock before navigation so timers created during mount are captured.
    await page.clock.install();
    await mockUserAuthenticated(page);
    await page.route('**/bff-api/auth/logout', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }),
    );

    await page.goto(`${BASE}/(app)/home`);
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 15000 });

    // Fast-forward 31 minutes — past the 30-minute idle timeout.
    await page.clock.fastForward(31 * 60 * 1000);

    await expect(page.getByTestId('login-screen')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('btn-login-with-keycloak')).toBeVisible();
    // FR-015: verify the exact inactivity message required by the spec
    await expect(page.getByText('Your session has expired due to inactivity. Please log in again.')).toBeVisible();
  });

  /**
   * T-150b: After absolute session timeout (24 h) the user is redirected to the login screen,
   * regardless of activity.
   */
  test('redirects to login screen after absolute session timeout', async ({ page }) => {
    await page.clock.install();
    await mockUserAuthenticated(page);
    await page.route('**/bff-api/auth/logout', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }),
    );

    await page.goto(`${BASE}/(app)/home`);
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 15000 });

    // Fast-forward 25 hours — past the 24-hour absolute timeout.
    await page.clock.fastForward(25 * 60 * 60 * 1000);

    await expect(page.getByTestId('login-screen')).toBeVisible({ timeout: 10000 });
    // FR-015: absolute timeout uses a distinct message from idle timeout
    await expect(page.getByText('Your session has expired. Please log in again.')).toBeVisible();
  });
});
