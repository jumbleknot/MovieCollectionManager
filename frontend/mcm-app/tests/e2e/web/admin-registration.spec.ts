/**
 * T032 — US3 "admin disables self-registration" web E2E (feature 040 / Item 1).
 *
 * Drives the REAL flow end-to-end against the live BFF + Keycloak + Mongo (no route mocks):
 *   - a freshly-minted mc-admin logs in and toggles self-registration OFF on the admin settings
 *     screen → the public registration-status flips → a signed-out visitor's login screen shows NO
 *     "Create Account" (`link-create-account` absent) → a direct POST /bff-api/auth/register is
 *     refused 403 → toggling back ON restores the Create Account affordance;
 *   - a non-admin (mc-user) is bounced from the admin settings screen (AuthGuard mc-admin).
 *
 * ISOLATION (playwright.config.ts): the self-registration setting is a SINGLE global doc the running
 * BFF reads, so while this spec holds it OFF any parallel spec hitting the real /register would see
 * an unrelated 403. It therefore runs in the DEPENDENT `lifecycle` project — strictly AFTER the main
 * `chromium` suite — the same isolation `bff-prod-lifecycle.spec.ts` uses for its session-poisoning
 * logout. Belt and braces: serial mode within the file, and afterAll unconditionally restores
 * registration ON (via the admin's own session) even if a test fails midway.
 *
 * Unlike bff-prod-lifecycle (one isolated identity → file-level `test.use({ storageState: empty })`),
 * this spec needs TWO identities at once — a throwaway mc-admin AND the shared mc-user — so it mints
 * explicit contexts. The throwaway admin is deleted in afterAll. Skips cleanly without the Keycloak
 * service secret.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import {
  createUserWithRoles,
  deleteUser,
  keycloakAdminEnabled,
  type AdminUser,
} from './setup/keycloak-admin';

test.describe.configure({ mode: 'serial' });

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
  // Let the opener finish the PKCE code exchange + BFF session before forcing /home (mirrors
  // global-setup): the app auto-navigates to /home on success; only then goto + assert.
  await page.waitForURL(`${BASE}/home`, { timeout: 30000 }).catch(() => {});
  await page.goto(`${BASE}/home`);
  await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 60000 });
}

async function registrationAllowed(page: Page): Promise<boolean> {
  const res = await page.request.get(`${BASE}/bff-api/auth/registration-status`);
  return ((await res.json()) as { allowed: boolean }).allowed;
}

/** Set the toggle to `desired` via the admin UI switch, verifying against the public status. */
async function setRegistration(adminPage: Page, desired: boolean): Promise<void> {
  await adminPage.goto(`${BASE}/(app)/admin/settings`);
  await expect(adminPage.getByTestId('admin-settings-screen')).toBeVisible({ timeout: 30000 });
  // The design-system Switch renders role="switch" (its testID isn't forwarded to the DOM node).
  const toggle = adminPage.getByRole('switch', { name: /self-registration/i });
  await expect(toggle).toBeVisible();
  if ((await registrationAllowed(adminPage)) !== desired) {
    await toggle.click();
  }
  await expect
    .poll(async () => registrationAllowed(adminPage), { timeout: 15000 })
    .toBe(desired);
}

test.describe('US3 — admin disables self-registration', () => {
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
    // Restore the shared global setting to ON no matter what (so auth.spec's register tests pass).
    try {
      await adminPage.request.patch(`${BASE}/bff-api/admin/settings`, {
        data: { allowSelfRegistration: true },
      });
    } catch {
      // best-effort
    }
    await adminCtx?.close();
    await deleteUser(admin?.userId);
  });

  test('disable hides Create Account + refuses register 403; re-enable restores it', async ({
    browser,
  }) => {
    // ── Admin disables registration via the UI ──────────────────────────────────
    await setRegistration(adminPage, false);

    // ── Signed-out visitor: NO Create Account on the login screen ────────────────
    const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anon = await anonCtx.newPage();
    await anon.goto(`${BASE}/(auth)/login`);
    await expect(anon.getByTestId('login-screen')).toBeVisible({ timeout: 20000 });
    await expect(anon.getByTestId('link-create-account')).toHaveCount(0);

    // ── A direct register call is refused 403 (server-side enforcement) ──────────
    const suffix = `${Date.now()}`;
    const refused = await anon.request.post(`${BASE}/bff-api/auth/register`, {
      data: {
        username: `blocked_${suffix}`.slice(0, 20),
        email: `blocked_${suffix}@test.invalid`,
        firstName: 'B',
        lastName: 'B',
        password: 'BlockedP@ss123!',
      },
    });
    expect(refused.status()).toBe(403);

    // ── Re-enable → Create Account returns ───────────────────────────────────────
    await setRegistration(adminPage, true);
    await anon.reload();
    await expect(anon.getByTestId('login-screen')).toBeVisible({ timeout: 20000 });
    await expect(anon.getByTestId('link-create-account')).toBeVisible({ timeout: 10000 });
    await anonCtx.close();
  });

  test('non-admin (mc-user) is blocked from the admin settings screen', async ({ page }) => {
    // `page` uses the shared mc-user (e2e-test-user) session from global-setup.
    await page.goto(`${BASE}/home`);
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 30000 });
    await page.goto(`${BASE}/(app)/admin/settings`);
    // AuthGuard(mc-admin) bounces a non-admin — the screen + toggle must never render for them.
    await expect(page.getByTestId('admin-settings-screen')).toHaveCount(0);
    await expect(page.getByTestId('toggle-self-registration')).toHaveCount(0);
  });
});
