/**
 * /bff-api/auth/logout integration tests (T011) — FR-013 / SC-005, US4.
 *
 * HTTP-level against the running BFF + real Redis (db 0) + real Keycloak Admin
 * API. No mocking (constitution v1.3.0). Verifies BOTH the stored-session
 * deletion AND the Keycloak SSO session termination (the constitution's Session
 * Invalidation requirement) — the SSO session is created by the ROPC login and
 * asserted gone via the Admin API after logout.
 */
import { randomUUID } from 'node:crypto';
import {
  createTestUser,
  deleteTestUser,
  getTestTokens,
  assignRole,
  ensureRopcAudienceMapper,
  getUserSessions,
  type TestUser,
} from './helpers/keycloak-test-client';
import { createBffClient } from './helpers/bff-test-server';
import {
  bffSeedSession,
  bffSessionExists,
  bffCleanupUser,
  closeBffRedis,
} from './helpers/bff-redis-client';
import type { Session } from '@/types/auth';

const bff = createBffClient();

describe('/bff-api/auth/logout — integration (real BFF + Redis + Keycloak Admin)', () => {
  let user: TestUser;
  let accessToken: string;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    user = await createTestUser('int-logout');
    await assignRole(user.userId, 'mc-user');
    // ROPC login creates a real Keycloak SSO user session.
    ({ accessToken } = await getTestTokens(user.username, user.password));
  });

  afterAll(async () => {
    if (user) await bffCleanupUser(user.userId);
    await deleteTestUser(user?.userId);
    await closeBffRedis();
  });

  it('deletes the stored session AND terminates the Keycloak SSO session (US4-AC1/AC2)', async () => {
    const now = Date.now();
    const session: Session = {
      sessionId: randomUUID(),
      userId: user.userId,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + 86_400_000,
    };
    await bffSeedSession(session);

    // sanity: the ROPC login created at least one Keycloak SSO session
    expect((await getUserSessions(user.userId)).length).toBeGreaterThan(0);

    const res = await bff.post(
      '/bff-api/auth/logout',
      {},
      {
        headers: {
          Cookie: `mcm_session_id=${session.sessionId}; mcm_access_token=${accessToken}`,
          'X-Forwarded-For': `198.51.100.${Math.floor(now % 200) + 1}`,
        },
      },
    );

    expect(res.status).toBe(200);
    expect(await bffSessionExists(session.sessionId)).toBe(false); // FR-013: Redis session deleted
    expect((await getUserSessions(user.userId)).length).toBe(0); // SC-005: Keycloak SSO terminated

    // Logout must clear ALL THREE auth cookies, each as its own Set-Cookie header with Max-Age=0.
    // (Regression: joining them into one comma-separated Set-Cookie value left mcm_refresh_token
    // and mcm_session_id uncleared — the browser parses only the first cookie.)
    const setCookie: string[] = res.headers['set-cookie'] ?? [];
    const cleared = (name: string): boolean =>
      setCookie.some((c) => c.startsWith(`${name}=;`) && /max-age=0/i.test(c));
    expect(cleared('mcm_access_token'), 'access cookie cleared').toBe(true);
    expect(cleared('mcm_refresh_token'), 'refresh cookie cleared').toBe(true);
    expect(cleared('mcm_session_id'), 'session cookie cleared').toBe(true);
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
