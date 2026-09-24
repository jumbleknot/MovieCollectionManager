/**
 * Web E2E — self-service account deletion (feature 076, T043; SC-002, FR-003, FR-004, FR-005).
 *
 * TIER: `@gate`. Deterministic, no model decision, so it belongs in the blocking tier. An
 * unclassified e2e test FAILS rather than defaulting into a tier
 * (openwiki/invariants/testing-tiers.md), so the tag is not decoration.
 *
 * A THROWAWAY IDENTITY, NEVER THE SHARED WORKER SESSION. This spec's whole purpose is to destroy
 * the account it signs in as; running it against the worker's identity would delete the user
 * every other spec depends on. It mints its own context for the same reason
 * `bff-prod-lifecycle` does, and `test.use({ storageState: … })` keeps the shared session out.
 *
 * It exercises the one thing no other tier can: that a real person, clicking through a real
 * browser, is sent to Keycloak, has to authenticate AGAIN even though they are already signed
 * in, and comes back to an account that is gone.
 *
 * Locators are `data-testid` — React Native Web renders the RN `testID` prop as `data-testid`,
 * and playwright.config.ts sets `testIdAttribute` to match.
 */
import { test, expect } from '@playwright/test';
import { type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './setup/target';
import {
  createUserWithRoles,
  deleteUser,
  keycloakAdminEnabled,
  type AdminUser,
} from './setup/keycloak-admin';

// Signed OUT by default: this spec supplies its own identity and must not inherit the shared one.
test.use({ storageState: { cookies: [], origins: [] } });

// The deletion is irreversible and the identity is single-use, so the cases must not interleave.
test.describe.configure({ mode: 'serial' });

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
    // SSO session already active — the popup closed before the form appeared.
  }
  await popup.waitForEvent('close', { timeout: 25000 }).catch(() => {});
  await page.waitForURL(`${BASE}/home`, { timeout: 30000 }).catch(() => {});
  await page.goto(`${BASE}/home`);
  await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 60000 });
}

test.describe('@gate account deletion', () => {
  let user: AdminUser | undefined;
  /** Kept after `user` is cleared, so the final case can try to sign in as the deleted account. */
  let deleted: { username: string; password: string } | undefined;

  test.beforeAll(async () => {
    test.skip(!keycloakAdminEnabled(), 'Keycloak admin credentials are not configured');
    user = await createUserWithRoles('e2e-del', ['mc-user']);
  });

  test.afterAll(async () => {
    // Best effort: the happy-path case deletes this user itself, so this is only for a failure
    // that left it behind.
    if (user?.userId) await deleteUser(user.userId).catch(() => undefined);
  });

  test('the dialog states what is destroyed AND what is left alone', async ({ page }) => {
    await loginAs(page, user!.username, user!.password);

    await page.goto(`${BASE}/settings/account`);
    await expect(page.getByTestId('account-danger-zone')).toBeVisible({ timeout: 30000 });

    // One click does not delete anything (FR-004).
    await page.getByTestId('account-delete-button').click();
    await expect(page.getByTestId('account-delete-dialog')).toBeVisible();

    // Both lists, before the user can confirm (FR-003). The second is the promise the user
    // cannot verify for themselves afterwards, so it must be made before they commit.
    await expect(page.getByText(/permanently delete/i)).toBeVisible();
    await expect(page.getByText(/will not touch/i)).toBeVisible();

    await page.getByTestId('account-delete-cancel').click();
    await expect(page.getByTestId('account-delete-dialog')).toBeHidden();
  });

  test('cancelling leaves the account intact', async ({ page }) => {
    await loginAs(page, user!.username, user!.password);

    await page.goto(`${BASE}/settings/account`);
    await page.getByTestId('account-delete-button').click();
    await page.getByTestId('account-delete-cancel').click();

    // Still signed in, still able to use the app.
    await page.goto(`${BASE}/home`);
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 30000 });
  });

  test('confirming re-authenticates at Keycloak and destroys the account', async ({ page }) => {
    await loginAs(page, user!.username, user!.password);

    await page.goto(`${BASE}/settings/account`);
    await page.getByTestId('account-delete-button').click();
    await page.getByTestId('account-delete-confirm').click();

    // THE ASSERTION THAT MATTERS HERE. The user is already signed in, and is asked for their
    // password again anyway — measured in T001, `max_age=0` re-prompts even with a live SSO
    // session. If this selector never appears, the step-up silently reused the session and the
    // re-authentication requirement has bought nothing.
    await page.waitForSelector('input[name="username"], input[name="password"]', {
      timeout: 30000,
    });

    const usernameField = page.locator('input[name="username"]');
    if (await usernameField.count()) await usernameField.fill(user!.username);
    await page.fill('input[name="password"]', user!.password);
    await page.press('input[name="password"]', 'Enter');

    await expect(page.getByTestId('account-deleted-confirmation')).toBeVisible({
      timeout: 60000,
    });
    // The page repeats the promise the user can no longer check themselves.
    await expect(page.getByText(/left untouched/i)).toBeVisible();

    deleted = { username: user!.username, password: user!.password };
    user = undefined; // it is gone; afterAll must not try to delete it again
  });

  test('the deleted account can no longer sign in', async ({ page }) => {
    // Deliberately NOT using loginAs: that helper asserts it reaches /home, which is the thing
    // that must now be impossible.
    await page.goto(`${BASE}/(auth)/login`);
    await page.waitForSelector('[data-testid="login-screen"]', { timeout: 20000 });

    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 20000 }),
      page.click('[data-testid="btn-login-with-keycloak"]'),
    ]);
    await popup.waitForSelector('input[name="username"]', { timeout: 15000 });
    await popup.fill('input[name="username"]', deleted!.username);
    await popup.fill('input[name="password"]', deleted!.password);

    // The credentials are the ones that worked minutes ago. The account is gone, so Keycloak
    // rejects them and the form stays put rather than closing on a successful sign-in.
    await popup.press('input[name="password"]', 'Enter');
    await expect(popup.locator('input[name="password"]')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('home-route')).toBeHidden();
  });
});
