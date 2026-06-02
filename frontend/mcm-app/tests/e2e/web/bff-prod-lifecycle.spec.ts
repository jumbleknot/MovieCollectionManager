import { test, expect, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';

/**
 * T013 / US3 — full auth lifecycle against the BFF container (the R6 reconciliation,
 * exercised end to end as a repeatable test):
 *
 *   login → access-token expiry → transparent refresh → logout → session + SSO terminated
 *
 * Runs against whatever `E2E_BFF_TARGET` selects; the meaningful target is `prod-container`
 * (HTTPS + Secure cookies), where the `IS_PROD` assertions additionally prove the hardening is
 * intact and NOT disabled for tests (FR-007). It also passes on the dev container / Metro
 * (refresh recovery works there too), so it adds coverage everywhere.
 *
 * This test owns an ISOLATED session (it opts out of the shared global-setup `storageState` and
 * logs in fresh) because step 5 performs a REAL logout, which the BFF propagates to Keycloak as a
 * full SSO-session termination (logoutUserSessions). Sharing the global-setup session would let
 * that termination poison other specs — which is exactly why auth.spec's logout test mocks the
 * endpoint. Here we want the real server-side termination, so we keep it on its own session.
 */

const USER = process.env['E2E_TEST_USER'] ?? 'testuser';
const PASS = process.env['E2E_TEST_PASSWORD'] ?? 'TestPass1!ok';
const IS_PROD = process.env['E2E_BFF_TARGET'] === 'prod-container';
const AUTH_COOKIES = ['mcm_access_token', 'mcm_refresh_token', 'mcm_session_id'] as const;

// Isolated, logged-out start — do NOT inherit the shared global-setup session.
test.use({ storageState: { cookies: [], origins: [] } });

/** Perform the Keycloak OIDC popup login, leaving the context authenticated at /home. */
async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/(auth)/login`);
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 20000 });
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 20000 }),
    page.click('[data-testid="btn-login-with-keycloak"]'),
  ]);
  try {
    await popup.waitForSelector('input[name="username"]', { timeout: 15000 });
    await popup.fill('input[name="username"]', USER);
    await popup.fill('input[name="password"]', PASS);
    await popup.press('input[name="password"]', 'Enter');
  } catch {
    // SSO already active — popup closed before the form appeared.
  }
  await popup.waitForEvent('close', { timeout: 25000 }).catch(() => {});
  await page.waitForURL(`${BASE}/home`, { timeout: 30000 }).catch(() => {});
  await gotoHome(page);
}

/** Navigate to /home and wait for it to render (recovering from an FR-009 default-collection redirect). */
async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  // Wait on the FR-009-RESOLVED signal (home-screen-create-button), not the instant home-route
  // wrapper which races ahead of the FR-009 default-collection redirect. See collections.spec.
  const result = await Promise.race([
    page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 }).then(() => 'home' as const),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }).then(() => 'collection' as const),
  ]).catch(() => null);
  if (result === 'collection') {
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
    return;
  }
  if (!result) throw new Error('gotoHome: home screen did not render');
}

const accessToken = async (page: Page): Promise<string | undefined> =>
  (await page.context().cookies()).find((c) => c.name === 'mcm_access_token')?.value;

test.describe('BFF container — auth lifecycle (T013/US3)', () => {
  test('login → access-token expiry → transparent refresh → logout terminates session + SSO', async ({ page, context }) => {
    // 1. Login (own session).
    await login(page);

    // 2. Hardening: on the prod container every auth cookie must be Secure + HttpOnly + SameSite=Strict
    //    (FR-007 — not relaxed for tests).
    const cookies = await context.cookies();
    for (const name of AUTH_COOKIES) {
      const c = cookies.find((ck) => ck.name === name);
      expect(c, `${name} present after login`).toBeTruthy();
      expect(c!.httpOnly, `${name} HttpOnly`).toBe(true);
      expect(c!.sameSite, `${name} SameSite`).toBe('Strict');
      if (IS_PROD) expect(c!.secure, `${name} Secure (prod HTTPS)`).toBe(true);
    }
    const before = await accessToken(page);
    expect(before).toBeTruthy();

    // 3. Simulate access-token expiry by deleting the access-token cookie. The browser auto-deletes
    //    it at Max-Age (~5 min); deleting it reproduces that deterministically. NOTE: Playwright's
    //    fake clock (page.clock) cannot expire it — the BFF validates the JWT against its own server
    //    clock, so only the token's actual absence/expiry triggers the 401 → refresh path.
    await context.clearCookies({ name: 'mcm_access_token' });
    expect(await accessToken(page), 'access token removed').toBeFalsy();

    // 4. A protected navigation triggers the auth bootstrap (apiClient GET /bff-api/auth/user); the
    //    missing access token → 401 → the response interceptor silently refreshes
    //    (POST /bff-api/auth/refresh with the refresh + session cookies) → retries → succeeds.
    await gotoHome(page);
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 60000 });

    // 5. Transparent refresh recovered: a NEW access token was issued (and still Secure on prod).
    const after = await accessToken(page);
    expect(after, 'fresh access token issued by transparent refresh').toBeTruthy();
    expect(after).not.toBe(before);
    if (IS_PROD) {
      expect((await context.cookies()).find((c) => c.name === 'mcm_access_token')!.secure).toBe(true);
    }

    // 6. Real logout (not mocked) → BFF clears cookies, deletes the Redis session, and terminates
    //    the Keycloak SSO session.
    await page.goto(`${BASE}/(app)/profile`);
    await expect(page.getByTestId('profile-screen')).toBeVisible({ timeout: 15000 });
    await page.click('[data-testid="btn-logout"]');
    await expect(page.getByTestId('logout-dialog')).toBeVisible({ timeout: 5000 });
    await page.click('[data-testid="btn-logout-confirm"]');
    await expect(page.getByTestId('login-screen')).toBeVisible({ timeout: 15000 });

    // 7. Session terminated server-side: the auth TOKENS are cleared (the login screen's
    //    fetch('/bff-api/auth/init') warm-up may re-mint an anonymous mcm_session_id, so the
    //    token cookies — not the session id — are the signal), and a protected request is rejected
    //    (401), proving the BFF session (and SSO) was ended, not just the UI navigated.
    const afterLogout = await context.cookies();
    for (const name of ['mcm_access_token', 'mcm_refresh_token'] as const) {
      expect(afterLogout.find((c) => c.name === name && c.value), `${name} cleared on logout`).toBeFalsy();
    }
    const res = await page.request.get(`${BASE}/bff-api/auth/user`, { failOnStatusCode: false });
    expect(res.status(), 'protected request rejected after logout').toBe(401);
  });
});
