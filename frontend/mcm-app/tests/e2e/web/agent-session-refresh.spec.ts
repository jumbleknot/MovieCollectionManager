/**
 * Server-side token renewal is invisible to the member (feature 085 US6 — AS-2, FR-018, SC-009).
 *
 * Before 085 the access token lived in a browser cookie and expired every ~5 min; the agent
 * transport (`utils/agent-fetch-refresh`) and the axios interceptor recovered by calling
 * /bff-api/auth/refresh on a 401. Since 085 the tokens are held by the BFF, inside the session, and
 * the BFF renews them itself when a request finds the access token due — so an expiry mid-session
 * produces NO 401 at all, and the browser never holds a token.
 *
 * This proves that chain on a real browser-PKCE session against the dev BFF container:
 *   1. authenticated → a protected route returns 200, and the cookie jar holds ONLY mcm_session_id
 *   2. the session's server-held access token is aged to "expired" (its clear expiry field)
 *   3. the protected route STILL returns 200 — the BFF renewed transparently; no 401, no token set
 *   4. the renewal really happened (the expiry moved forward), and /auth/refresh — still the
 *      client's fallback — succeeds with the session cookie alone and sets nothing but it.
 *
 * Suite-safety: each worker holds its own session (feature 052), so renewing it touches no other
 * worker's tokens or rate-limit bucket.
 */

import { test, expect } from './fixtures/worker-session';
import { type APIRequestContext, type BrowserContext } from '@playwright/test';

import { ageServerHeldAccessToken, serverHeldAccessExpiry } from './setup/bff-session-store';

const PROTECTED = '/bff-api/auth/user';
const RETIRED_TOKEN_COOKIES = ['mcm_access_token', 'mcm_refresh_token'];

async function sessionId(context: BrowserContext): Promise<string> {
  const c = (await context.cookies()).find((x) => x.name === 'mcm_session_id');
  expect(c, 'the worker session should carry mcm_session_id').toBeTruthy();
  return c!.value;
}

test.describe('Server-held tokens — renewal is transparent (085 US6)', () => {
  test('an expired server-held access token is renewed with no 401 and nothing stored client-side', { tag: '@gate' }, async ({
    page,
  }) => {
    const context = page.context();
    const api: APIRequestContext = page.request; // shares the context cookie jar + storageState

    // 1. Baseline, and the client holds the session reference only (FR-016, SC-007).
    expect((await api.get(PROTECTED)).status(), 'baseline protected call should be authenticated').toBe(200);
    const names = (await context.cookies()).map((c) => c.name);
    for (const retired of RETIRED_TOKEN_COOKIES) expect(names, `${retired} must not be held`).not.toContain(retired);
    const sid = await sessionId(context);

    // 2. The access token "expires" — on the server, where it lives.
    const { before } = await ageServerHeldAccessToken(sid);

    // 3. No 401: the BFF renews it on this very request (FR-018).
    const after = await api.get(PROTECTED);
    expect(after.status(), 'an expired server-held token must be renewed, not answered with 401').toBe(200);
    expect(after.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value).join(';'))
      .not.toMatch(/mcm_(access|refresh)_token=[^;]/);

    // 4. The renewal happened, and the client fallback still works on the session cookie alone.
    expect((await serverHeldAccessExpiry(sid)) ?? 0, 'the server-held token was renewed').toBeGreaterThan(Date.now());
    expect(before).toBeGreaterThan(0);
    const refreshed = await api.post('/bff-api/auth/refresh');
    expect(refreshed.status(), '/auth/refresh renews the session on the session cookie alone').toBe(200);
    const setCookies = refreshed.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
    expect(setCookies.map((v) => v.split('=')[0])).toEqual(['mcm_session_id']);
  });
});
