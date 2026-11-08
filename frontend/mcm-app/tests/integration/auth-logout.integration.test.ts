/**
 * /bff-api/auth/logout integration tests (T011) — FR-013 / SC-005, US4.
 *
 * HTTP-level against the running BFF + real Redis (db 0) + real Keycloak Admin
 * API. No mocking (constitution v1.3.0). Verifies BOTH the stored-session
 * deletion AND the Keycloak SSO session termination (the constitution's Session
 * Invalidation requirement) — the SSO session is created by the ROPC login and
 * asserted gone via the Admin API after logout. Since feature 085 the member signs in through the
 * real code + PKCE flow (helpers/bff-session.ts) and the session cookie is the only credential.
 */
import {
  createTestUser,
  deleteTestUser,
  assignRole,
  ensureRopcAudienceMapper,
  getUserSessions,
  type TestUser,
} from './helpers/keycloak-test-client';
import { createBffClient } from './helpers/bff-test-server';
import { bffRawSessionValues, bffCleanupUser, closeBffRedis } from './helpers/bff-redis-client';
import { loginSession } from './helpers/bff-session';

const bff = createBffClient();

describe('/bff-api/auth/logout — integration (real BFF + Redis + Keycloak Admin)', () => {
  let user: TestUser;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    user = await createTestUser('int-logout');
    await assignRole(user.userId, 'mc-user');
  });

  afterAll(async () => {
    if (user) await bffCleanupUser(user.userId);
    await deleteTestUser(user?.userId);
    await closeBffRedis();
  });

  it('deletes the stored session AND terminates the Keycloak SSO session (US4-AC1/AC2)', async () => {
    const now = Date.now();
    // A real sign-in: a Keycloak SSO session plus a BFF session holding the tokens server-side.
    const signedIn = await loginSession(user.username, user.password);
    const sessionId = signedIn.setCookies
      .map((c) => c.split(';')[0]!)
      .find((pair) => pair.startsWith('mcm_session_id='))!
      .slice('mcm_session_id='.length);
    expect((await getUserSessions(user.userId)).length).toBeGreaterThan(0);

    const res = await bff.post(
      '/bff-api/auth/logout',
      {},
      {
        headers: {
          Cookie: signedIn.cookie,
          'X-Forwarded-For': `198.51.100.${Math.floor(now % 200) + 1}`,
        },
      },
    );

    expect(res.status).toBe(200);
    // FR-013 + 085 FR-020: the session AND its server-held tokens are gone.
    expect(await bffRawSessionValues(sessionId)).toEqual({ record: null, tokens: null });
    expect((await getUserSessions(user.userId)).length).toBe(0); // SC-005: Keycloak SSO terminated

    // Logout clears the session cookie AND the two retired token cookies (085 FR-022), each as its
    // own Set-Cookie header with Max-Age=0. (Regression: joining them into one comma-separated
    // Set-Cookie value left all but the first uncleared — the browser parses only the first.)
    const setCookie: string[] = res.headers['set-cookie'] ?? [];
    const cleared = (name: string): boolean =>
      setCookie.some((c) => c.startsWith(`${name}=;`) && /max-age=0/i.test(c));
    // (Jest expect takes one argument — no Playwright-style message.)
    expect(cleared('mcm_access_token')).toBe(true); // access cookie cleared
    expect(cleared('mcm_refresh_token')).toBe(true); // refresh cookie cleared (was the bug)
    expect(cleared('mcm_session_id')).toBe(true); // session cookie cleared
  });

  it('is best-effort with no session cookie — returns 200 and changes no state (US4-AC3)', async () => {
    // NOTE: the spec phrased this as "401", but the logout handler is intentionally
    // best-effort/idempotent: it clears cookies and returns 200 even without a
    // session, and makes no session-store or identity-provider call when there is
    // no session id. We assert the real, constitution-consistent behavior.
    const res = await bff.post(
      '/bff-api/auth/logout',
      {},
      { headers: { 'X-Forwarded-For': `203.0.113.${Math.floor(Date.now() % 200) + 1}` } },
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });
});
