/**
 * Web E2E — the admin-settings entry point (feature 040 follow-on).
 *
 * Feature 040 US3 built the admin settings screen but wired no affordance to reach it. This spec
 * covers the new Profile-screen card that closes that gap:
 *   - POSITIVE: a freshly-minted mc-admin sees `profile-admin-settings-card` on Profile, taps it, and
 *     lands on `admin-settings-screen`.
 *   - NEGATIVE: the shared mc-user (e2e-test-user) sees NO card on Profile.
 *
 * Unlike admin-registration.spec.ts this spec NEVER toggles the app-wide self-registration setting —
 * it only reads the card and navigates — so it carries no global-state hazard and runs in the main
 * `chromium` project (not the dependent `lifecycle` project). The positive case still needs an
 * mc-admin identity, so it mints a throwaway admin in its own empty context (deleted in afterAll) and
 * skips cleanly without the Keycloak service secret; the negative case uses the shared session.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import {
  createUserWithRoles,
  deleteUser,
  keycloakAdminEnabled,
  type AdminUser,
} from './setup/keycloak-admin';

/** Log in through the real Keycloak popup with explicit creds (mirrors the global-setup path). */
async function loginAs(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${BASE}/(auth)/login`);
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 20000 });
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 20000 }),
    page.click('[data-testid="btn-login-with-keycloak"]'),
  ]);
  try {
    await popup.waitForSelector('input[name="username"]', { timeout: 15000 });
    await popup.fill('input[name="username"]', username);
    await popup.fill('input[name="password"]', password);
    await popup.press('input[name="password"]', 'Enter');
  } catch {
    // SSO session already active — popup closed before the form appeared.
  }
  await popup.waitForEvent('close', { timeout: 25000 }).catch(() => {});
  await page.waitForURL(`${BASE}/home`, { timeout: 30000 }).catch(() => {});
  await page.goto(`${BASE}/home`);
  await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 60000 });
}

test.describe('Admin-settings entry point (Profile card)', () => {
  test('mc-user sees NO admin-settings card on Profile', async ({ page }) => {
    // `page` uses the shared mc-user (e2e-test-user) session from global-setup.
    await page.goto(`${BASE}/(app)/profile`);
    await expect(page.getByTestId('profile-screen')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('profile-admin-settings-card')).toHaveCount(0);
  });

  test.describe('minted mc-admin', () => {
    test.skip(!keycloakAdminEnabled(), 'KEYCLOAK_SERVICE_CLIENT_SECRET not set (admin user seeding)');

    let admin: AdminUser;
    let adminCtx: BrowserContext;
    let adminPage: Page;

    test.beforeAll(async ({ browser }) => {
      admin = await createUserWithRoles('e2e-admin', ['mc-user', 'mc-admin']);
      // Explicit EMPTY storageState — else the context inherits the shared mc-user session and the
      // app boots already-authenticated (no login screen, no Keycloak popup).
      adminCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      adminPage = await adminCtx.newPage();
      await loginAs(adminPage, admin.username, admin.password);
    });

    test.afterAll(async () => {
      await adminCtx?.close();
      await deleteUser(admin?.userId);
    });

    test('sees the card and taps through to the admin settings screen', async () => {
      await adminPage.goto(`${BASE}/(app)/profile`);
      await expect(adminPage.getByTestId('profile-screen')).toBeVisible({ timeout: 30000 });
      const card = adminPage.getByTestId('profile-admin-settings-card');
      await expect(card).toBeVisible({ timeout: 15000 });
      await card.click();
      await expect(adminPage.getByTestId('admin-settings-screen')).toBeVisible({ timeout: 30000 });
      // The DS Switch renders role="switch" but does NOT forward its testID to the DOM (same
      // limitation as the Card — see admin-registration.spec.ts) — assert the control by role.
      await expect(adminPage.getByRole('switch', { name: /self-registration/i })).toBeVisible();
    });
  });
});
