/**
 * Web E2E — no page is refused by the browser or crashes in it (feature 087; US2 scenario 5, US3
 * scenario 5, FR-009).
 *
 * TIER: `@gate`. Deterministic, no model decision. An unclassified e2e test fails rather than
 * defaulting into a tier (openwiki/invariants/testing-tiers.md), so the tag is not decoration.
 *
 * WHY A WALK. A script the CSP blocks produces no failed request, so nothing else in the suite sees it.
 * It covers each way a page can start: a fresh sign-in, a hard reload, a deep link, and in-app navigation,
 * because each loads different code at a different moment.
 *
 * A THROWAWAY IDENTITY, in the `lifecycle` project. A real sign-in in the main project could evict
 * another worker's session, because the BFF caps concurrent sessions per user. This user has no assistant
 * configured, so the assistant chunk is not checked here: `assistant-navigate.spec.ts` covers that path
 * with the same watch.
 *
 * Running it alone: `lifecycle` depends on `chromium`, so use
 * `tests/e2e/web/page-security-policy-walk.spec.ts --project=lifecycle --no-deps`, or it runs all the tests.
 * The negative control is in specs/087-expo-sdk-58/contracts/web-gates.md.
 */
import { test, expect } from '@playwright/test';
import { type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupOwnedCollections, ownCollection } from './setup/e2e-cleanup';
import {
  createUserWithRoles,
  deleteUser,
  keycloakAdminEnabled,
  type AdminUser,
} from './setup/keycloak-admin';
import { assertRightServer, watchSecurityPolicy } from './fixtures/security-policy-watch';

// Signed out by default: this spec supplies its own identity and must not inherit the shared one.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('@gate the browser refuses nothing on the app pages', () => {
  let user: AdminUser | undefined;

  test.beforeAll(async () => {
    if (!keycloakAdminEnabled()) {
      if (process.env['CI']) throw new Error('Keycloak admin credentials are required for this walk under CI');
      test.skip(true, 'Keycloak admin credentials are not configured');
    }
    user = await createUserWithRoles('e2e-csp', ['mc-user']);
  });

  test.afterAll(async () => {
    if (user?.userId) await deleteUser(user.userId).catch(() => undefined);
  });

  test.afterEach(async ({ page }) => {
    await cleanupOwnedCollections(page.request);
  });

  async function signIn(page: Page): Promise<void> {
    await page.waitForSelector('[data-testid="login-screen"]', { timeout: 20_000 });
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 20_000 }),
      page.click('[data-testid="btn-login-with-keycloak"]'),
    ]);
    await popup.waitForSelector('input[name="username"]', { timeout: 15_000 });
    await popup.fill('input[name="username"]', user!.username);
    await popup.fill('input[name="password"]', user!.password);
    await popup.press('input[name="password"]', 'Enter');
    await popup.waitForEvent('close', { timeout: 25_000 }).catch(() => {});
    await page.waitForURL(`${BASE}/home`, { timeout: 30_000 });
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 60_000 });
  }

  test('sign-in, hard reload, deep link and in-app navigation are all clean', { tag: '@gate' }, async ({ page }) => {
    test.setTimeout(180_000);
    const watch = await watchSecurityPolicy(page.context(), BASE);

    const loginResponse = await page.goto(`${BASE}/(auth)/login`);
    assertRightServer(loginResponse);
    await page.waitForSelector('[data-testid="login-screen"]', { timeout: 20_000 });
    watch.assertClean('first load of the login page');
    await watch.proveCanSee(page);

    await signIn(page);
    watch.assertClean('sign-in');

    await page.reload();
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 60_000 });
    watch.assertClean('hard reload of /home');

    const name = `csp-walk-${Date.now()}`;
    ownCollection(name);
    const created = await page.request.post(`${BASE}/bff-api/collections`, { data: { name } });
    expect(created.ok(), `creating ${name} answered ${created.status()}`).toBeTruthy();
    const { collectionId } = (await created.json()) as { collectionId: string };
    await page.goto(`${BASE}/collections/${collectionId}`);
    await expect(page.getByTestId('collection-screen-add-movie')).toBeVisible({ timeout: 60_000 });
    watch.assertClean('deep link to a collection');

    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-profile-screen')).toBeVisible({ timeout: 30_000 });
    watch.assertClean('in-app navigation to Settings');
  });

  test('an unknown page answers 404, and a page is not served as immutable', { tag: '@gate' }, async ({ page }) => {
    const missing = await page.request.get(`${BASE}/no-such-page`);
    expect(missing.status()).toBe(404);

    const login = await page.request.get(`${BASE}/(auth)/login`);
    expect(login.status()).toBe(200);
    expect(login.headers()['cache-control'] ?? '').not.toContain('immutable');
  });
});
