import { test, expect, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { requireEnv } from './setup/load-e2e-env';

/**
 * T013 / US3 — full auth lifecycle against the BFF container (the R6 reconciliation,
 * exercised end to end as a repeatable test):
 *
 *   login → the client holds ONLY the session reference → protected navigation → logout →
 *   session + SSO terminated
 *
 * Feature 085 moved the member's tokens server-side. This spec used to stage "access-token expiry"
 * by deleting the access-token cookie; there is no such cookie any more, and the BFF renews the
 * server-held token itself. That renewal is proven in agent-session-refresh.spec.ts, which can age
 * the server-held token through the dev stack's store — this spec also runs against the prod
 * container, whose store is not host-reachable.
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

// Feature 027 US4: each Playwright spec worker loads .env.e2e.local itself (global-setup's env does
// not propagate across worker processes); credentials never come from a hardcoded fallback.
const USER = requireEnv('E2E_TEST_USER');
const PASS = requireEnv('E2E_TEST_PASSWORD');
const IS_PROD = process.env['E2E_BFF_TARGET'] === 'prod-container';
const RETIRED_TOKEN_COOKIES = ['mcm_access_token', 'mcm_refresh_token'] as const;

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
    page
      .waitForSelector('[data-testid="home-screen-create-button"]', {
        state: 'visible',
        timeout: 60000,
      })
      .then(() => 'home' as const),
    page
      .waitForSelector('[data-testid="collection-screen-add-movie"]', {
        state: 'visible',
        timeout: 60000,
      })
      .then(() => 'collection' as const),
  ]).catch(() => null);
  if (result === 'collection') {
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-screen-create-button"]', {
      state: 'visible',
      timeout: 60000,
    });
    return;
  }
  if (!result) throw new Error('gotoHome: home screen did not render');
}

test.describe('BFF container — auth lifecycle (T013/US3)', () => {
  test('login → the client holds only the session reference → logout terminates session + SSO', async ({
    page,
    context,
  }) => {
    // 1. Login (own session).
    await login(page);

    // 2. The client holds ONE credential — the session reference — and no token (085 FR-016,
    //    SC-007). On the prod container it must be Secure + HttpOnly + SameSite=Strict (FR-007 —
    //    not relaxed for tests).
    const cookies = await context.cookies();
    for (const name of RETIRED_TOKEN_COOKIES) {
      expect(
        cookies.find((ck) => ck.name === name && ck.value),
        `${name} must not be held by the client`,
      ).toBeFalsy();
    }
    const session = cookies.find((ck) => ck.name === 'mcm_session_id');
    expect(session, 'mcm_session_id present after login').toBeTruthy();
    expect(session!.httpOnly, 'mcm_session_id HttpOnly').toBe(true);
    expect(session!.sameSite, 'mcm_session_id SameSite').toBe('Strict');
    if (IS_PROD) expect(session!.secure, 'mcm_session_id Secure (prod HTTPS)').toBe(true);

    // 3. A protected navigation authenticates through the session alone.
    await gotoHome(page);
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 60000 });
    expect((await page.request.get(`${BASE}/bff-api/auth/user`)).status()).toBe(200);

    // 4. Real logout (not mocked) → BFF clears cookies, deletes the Redis session, and terminates
    //    the Keycloak SSO session.
    await page.goto(`${BASE}/(app)/settings`);
    await expect(page.getByTestId('settings-profile-screen')).toBeVisible({ timeout: 15000 });
    await page.click('[data-testid="btn-logout"]');
    await expect(page.getByTestId('logout-dialog')).toBeVisible({ timeout: 5000 });
    await page.click('[data-testid="btn-logout-confirm"]');
    await expect(page.getByTestId('login-screen')).toBeVisible({ timeout: 15000 });

    // 5. Session terminated server-side: the session reference no longer authenticates (401) —
    //    proving the BFF session (and SSO) was ended, not just the UI navigated (085 US6 AS-3).
    const afterLogout = await context.cookies();
    expect(
      afterLogout.find((c) => c.name === 'mcm_session_id' && c.value === session!.value),
      'old session reference cleared',
    ).toBeFalsy();
    const res = await page.request.get(`${BASE}/bff-api/auth/user`, { failOnStatusCode: false });
    expect(res.status(), 'protected request rejected after logout').toBe(401);
  });
});
