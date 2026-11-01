/**
 * /bff-api/auth/refresh integration tests (T010) — FR-012 guard paths.
 *
 * HTTP-level against the running BFF + real Redis (db 0). No mocking
 * (constitution v1.3.0).
 *
 * /auth/refresh refreshes against the production client (movie-collection-manager), whose
 * refresh tokens are obtainable only through the browser PKCE flow — the direct-grant test client
 * must never be enabled on the production client. Feature 085 walks that flow from Node
 * (helpers/bff-session.ts), so the happy path and the session-ownership check (US2) are now
 * covered here against real Keycloak, with real BFF-issued refresh tokens. A ROPC refresh token
 * would not exercise the ownership check at all: Keycloak refuses it on the production client
 * (client mismatch) before the BFF ever compares owners.
 */
import { randomUUID } from 'node:crypto';
import { createBffClient } from './helpers/bff-test-server';
import {
  bffSeedSession,
  bffSessionExists,
  bffCleanupUser,
  closeBffRedis,
} from './helpers/bff-redis-client';
import { assignRole, createTestUser, deleteTestUser, type TestUser } from './helpers/keycloak-test-client';
import { loginSession } from './helpers/bff-session';
import type { Session } from '@/types/auth';

const bff = createBffClient();

// One connection for the whole file: a describe-level quit would close it under the next block.
afterAll(async () => {
  await closeBffRedis();
});

describe('/bff-api/auth/refresh — integration guard paths (real BFF + Redis)', () => {
  const seededUserIds: string[] = [];

  afterAll(async () => {
    for (const uid of seededUserIds) await bffCleanupUser(uid);
  });

  it('returns 401 with no session cookie (US3-AC1)', async () => {
    const res = await bff.post('/bff-api/auth/refresh', {});
    expect(res.status).toBe(401);
    expect(res.data.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 401 when the session is not in the store (US3-AC2)', async () => {
    const res = await bff.post(
      '/bff-api/auth/refresh',
      {},
      { headers: { Cookie: `mcm_session_id=${randomUUID()}` } },
    );
    expect(res.status).toBe(401);
    expect(res.data.code).toBe('SESSION_EXPIRED');
  });

  it('returns 401 for a valid session with no refresh-token cookie (US3-AC3)', async () => {
    const now = Date.now();
    const session: Session = {
      sessionId: randomUUID(),
      userId: `int-refresh-${randomUUID().slice(0, 8)}`,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + 86_400_000,
    };
    seededUserIds.push(session.userId);
    await bffSeedSession(session);

    const res = await bff.post(
      '/bff-api/auth/refresh',
      {},
      { headers: { Cookie: `mcm_session_id=${session.sessionId}` } },
    );
    expect(res.status).toBe(401);
    expect(res.data.code).toBe('REFRESH_TOKEN_INVALID');
  });
});

/** The value of cookie `name` in a set of `Set-Cookie` lines. */
const cookieValue = (setCookies: string[], name: string): string | undefined =>
  setCookies.map((c) => c.split(';')[0]!).find((pair) => pair.startsWith(`${name}=`))?.slice(name.length + 1);

describe('/bff-api/auth/refresh — session ownership (feature 085 US2, real Keycloak sessions)', () => {
  let memberA: TestUser;
  let memberB: TestUser;

  beforeAll(async () => {
    memberA = await createTestUser('int-refresh-own-a');
    memberB = await createTestUser('int-refresh-own-b');
    await assignRole(memberA.userId, 'mc-user');
    await assignRole(memberB.userId, 'mc-user');
  });

  afterAll(async () => {
    for (const m of [memberA, memberB]) {
      await bffCleanupUser(m.userId).catch(() => {});
      await deleteTestUser(m.userId).catch(() => {});
    }
  });

  it("refuses member B's refresh credential on member A's session, and ends A's session (US2 AS-1, SC-003)", async () => {
    const a = await loginSession(memberA.username, memberA.password);
    const b = await loginSession(memberB.username, memberB.password);
    const aSession = cookieValue(a.setCookies, 'mcm_session_id')!;
    const bRefresh = cookieValue(b.setCookies, 'mcm_refresh_token')!;
    expect(aSession).toBeTruthy();
    expect(bRefresh).toBeTruthy();

    const res = await bff.post('/bff-api/auth/refresh', {}, {
      headers: { Cookie: `mcm_session_id=${aSession}; mcm_refresh_token=${bRefresh}` },
    });

    expect(res.status).toBe(401);
    expect(res.data.code).toBe('SESSION_OWNER_MISMATCH');
    const issued = ((res.headers['set-cookie'] as string[] | undefined) ?? []).filter((c) => !/Max-Age=0/.test(c));
    expect(issued).toEqual([]);
    expect(await bffSessionExists(aSession)).toBe(false);
  });

  it('a same-member refresh succeeds (US2 AS-2)', async () => {
    const a = await loginSession(memberA.username, memberA.password);
    const res = await bff.post('/bff-api/auth/refresh', {}, {
      headers: {
        Cookie: `mcm_session_id=${cookieValue(a.setCookies, 'mcm_session_id')}; ` +
          `mcm_refresh_token=${cookieValue(a.setCookies, 'mcm_refresh_token')}`,
      },
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });
});
