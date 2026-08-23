/**
 * Web E2E — reaching the admin settings area (feature 062; reworked from admin-card.spec.ts).
 *
 * FR-008, FR-009. Feature 040 US3 built the admin settings screen but wired no affordance to
 * reach it; a Profile-screen card was added as a follow-on. Feature 062 deletes that card — the
 * settings sub-navigation replaces it — so this spec is reworked around the entry rather than
 * patched, and gains the case the card-based spec never had:
 *
 *   - VISIBILITY (presentation): an mc-admin sees `settings-nav-admin` and reaches
 *     `admin-settings-screen` through it; the shared mc-user sees no entry at all.
 *   - ENFORCEMENT (access control): navigating STRAIGHT to /(app)/settings/admin renders the
 *     screen for an admin and does not for an mc-user — neither having rendered the
 *     sub-navigation first. Hiding a link is not access control
 *     (openwiki/gotchas/role-enforcement-is-a-layer.md); ProtectedRoute → AuthGuard is.
 *
 * The direct-URL case is written as a PAIR inside one test on purpose. Asserting only the
 * refusal would pass vacuously while the route does not exist yet, so the positive half is what
 * makes it capable of failing before the route lands.
 *
 * Like the spec it replaces, this NEVER toggles the app-wide self-registration setting — it only
 * reads and navigates — so it carries no global-state hazard and runs in the main `chromium`
 * project (not the dependent `lifecycle` project). The admin cases still need an mc-admin
 * identity, so they mint a throwaway admin in their own empty context (deleted in afterAll) and
 * skip cleanly without the Keycloak service secret.
 */
import { test, expect } from './fixtures/worker-session';
import { type BrowserContext, type Page } from '@playwright/test';

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

test.describe('Admin settings area — visibility and enforcement', () => {
  test('mc-user sees NO Admin entry in the settings sub-navigation', async ({ page }) => {
    // `page` uses the shared mc-user (e2e-test-user) session from global-setup.
    await page.goto(`${BASE}/(app)/settings`);
    await expect(page.getByTestId('settings-profile-screen')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('settings-nav')).toBeVisible();
    // Absent from the DOM entirely, not merely invisible.
    await expect(page.getByTestId('settings-nav-admin')).toHaveCount(0);
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

    test('sees the Admin entry and reaches the admin settings screen through it', async () => {
      await adminPage.goto(`${BASE}/(app)/settings`);
      await expect(adminPage.getByTestId('settings-profile-screen')).toBeVisible({ timeout: 30000 });
      const entry = adminPage.getByTestId('settings-nav-admin');
      await expect(entry).toBeVisible({ timeout: 15000 });
      await entry.click();
      await expect(adminPage).toHaveURL(/\/settings\/admin$/, { timeout: 20000 });
      await expect(adminPage.getByTestId('admin-settings-screen')).toBeVisible({ timeout: 30000 });
      // The DS Switch renders role="switch" but does NOT forward its testID to the DOM (same
      // limitation as the Card — see admin-registration.spec.ts) — assert the control by role.
      await expect(adminPage.getByRole('switch', { name: /self-registration/i })).toBeVisible();
    });

    test('the address itself admits an admin and refuses an mc-user, sub-navigation never rendered', async ({ page }) => {
      // THE PAIR. Both halves go straight to the address — neither renders the sub-navigation
      // first — so what is being tested is the route's own guard, not the entry's visibility.

      // Positive half: without this the negative half would pass while the route did not exist.
      await adminPage.goto(`${BASE}/(app)/settings/admin`);
      await expect(adminPage.getByTestId('admin-settings-screen')).toBeVisible({ timeout: 30000 });

      // Negative half: the mc-user session, refused by ProtectedRoute → AuthGuard.
      await page.goto(`${BASE}/(app)/settings/admin`);
      await expect(page.getByTestId('admin-settings-screen')).toHaveCount(0);
      // Refused, not merely blank: AuthGuard redirects a caller without the role away.
      await expect(page).not.toHaveURL(/\/settings\/admin$/, { timeout: 20000 });
    });
  });
});
