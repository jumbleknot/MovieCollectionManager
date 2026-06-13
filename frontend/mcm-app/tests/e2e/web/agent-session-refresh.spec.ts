/**
 * 013-inc4: server-side proof of the agent transport's 401 → refresh → retry recovery.
 *
 * The CopilotKit agent `/run` fetch authenticates via the BFF `mcm_access_token` cookie (RN's
 * XMLHttpRequest defaults `withCredentials=true`, so the cookie rides along). That access cookie is
 * short-lived (~5 min). When it expires mid-session, `utils/agent-fetch-refresh.createRefreshingFetch`
 * is supposed to: see a 401, call `silentRefresh()` (POST /bff-api/auth/refresh), then retry once.
 * The client ORCHESTRATION is unit-tested (agent-fetch-refresh.test.ts); THIS test proves the
 * SERVER chain it depends on actually works end-to-end on a real browser-PKCE session:
 *
 *   1. authenticated → a protected route returns 200 (baseline)
 *   2. drop ONLY the access cookie (faithfully simulates the ~5-min expiry; refresh+session remain)
 *   3. the protected route now 401s with `no_token` (exactly what the agent /run sees)
 *   4. POST /bff-api/auth/refresh ROTATES and re-sets a fresh `mcm_access_token` cookie
 *   5. the retry (same context, new cookie) returns 200 — recovered
 *
 * This closes the gap flagged as "headless-untestable" for /auth/refresh (a Node/ROPC client can't
 * get a browser-PKCE refresh token, but a Playwright browser context can). Run against the dev BFF
 * container (the same target as the rest of the agent E2E):
 *   E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/agent-session-refresh.spec.ts
 *
 * Suite-safety: this rotates the refresh token for the shared test user. Refresh-token rotation
 * invalidates only the OLD refresh token; the access cookies other specs loaded from storageState
 * stay valid for their natural ~5-min lifetime, so parallel specs are unaffected.
 */

import { test, expect, type BrowserContext, type APIRequestContext } from '@playwright/test';

const ACCESS_COOKIE = 'mcm_access_token';
const PROTECTED = '/bff-api/auth/user'; // requireAuth-guarded; 200 authed, 401 no_token otherwise

async function accessCookie(context: BrowserContext): Promise<string | undefined> {
  const c = (await context.cookies()).find((x) => x.name === ACCESS_COOKIE);
  return c?.value;
}

test.describe('Agent session recovery — 401 → refresh → retry (server chain)', () => {
  test('an expired access cookie recovers via /auth/refresh and the retry succeeds', async ({
    page,
  }) => {
    const context = page.context();
    const api: APIRequestContext = page.request; // shares the context cookie jar + storageState

    // 1. Baseline: the shared authenticated session can read a protected route.
    const baseline = await api.get(PROTECTED);
    expect(baseline.status(), 'baseline protected call should be authenticated').toBe(200);
    const originalAccess = await accessCookie(context);
    expect(originalAccess, 'an access cookie should exist before expiry').toBeTruthy();

    // 2. Simulate the ~5-min access-token expiry: drop ONLY the access cookie. The refresh cookie
    //    (Path=/bff-api/auth/refresh) and the session cookie remain, exactly as on a real expiry.
    await context.clearCookies({ name: ACCESS_COOKIE });
    expect(await accessCookie(context)).toBeUndefined();

    // 3. The protected route now fails the way the agent /run does: no access token → 401.
    const expired = await api.get(PROTECTED);
    expect(expired.status(), 'a missing access cookie must 401 (no_token)').toBe(401);

    // 4. silentRefresh()'s server call: POST /auth/refresh rotates + re-sets a fresh access cookie.
    const refreshed = await api.post('/bff-api/auth/refresh');
    expect(refreshed.status(), '/auth/refresh should succeed with the refresh cookie').toBe(200);
    const newAccess = await accessCookie(context);
    expect(newAccess, 'refresh must re-set the access cookie').toBeTruthy();
    expect(newAccess, 'the access cookie should be rotated (a new value)').not.toBe(originalAccess);

    // 5. The retry (what createRefreshingFetch does) now authenticates with the fresh cookie.
    const retry = await api.get(PROTECTED);
    expect(retry.status(), 'the retry after refresh must succeed (recovered)').toBe(200);
  });
});
