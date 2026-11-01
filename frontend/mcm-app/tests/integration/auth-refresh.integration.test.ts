/**
 * /bff-api/auth/refresh integration tests (T010) — FR-012 guard paths.
 *
 * HTTP-level against the running BFF + real Redis (db 0). No mocking
 * (constitution v1.3.0).
 *
 * /auth/refresh renews the SERVER-HELD tokens of the caller's own session (feature 085): members
 * sign in through Keycloak's real code + PKCE flow (helpers/bff-session.ts), so the happy path
 * and the ownership guarantee run against real Keycloak. The FR-006 tamper case — another
 * member's sealed tokens inside this session — is in session-token-custody.integration.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { createBffClient } from './helpers/bff-test-server';
import {
  bffSeedSession,
  bffCleanupUser,
  closeBffRedis,
} from './helpers/bff-redis-client';
import { assignRole, createTestUser, deleteTestUser, getTestTokens, type TestUser } from './helpers/keycloak-test-client';
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

describe("/bff-api/auth/refresh — the caller's own session only (feature 085, real Keycloak sessions)", () => {
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

  // US2 under server-held tokens (FR-021): the refresh token is the SESSION's, so a client cannot
  // present someone else's. B's genuine, live refresh token sent as a cookie is simply not read —
  // A's session renews with A's own tokens and stays A's.
  it("a refresh-token cookie from another member is ignored: the session renews as its own owner (US2, FR-021)", async () => {
    const a = await loginSession(memberA.username, memberA.password);
    const { refreshToken: bRefresh } = await getTestTokens(memberB.username, memberB.password);

    const res = await bff.post('/bff-api/auth/refresh', {}, {
      headers: { Cookie: `${a.cookie}; mcm_refresh_token=${bRefresh}` },
    });
    expect(res.status).toBe(200);

    const user = await bff.get('/bff-api/auth/user', { headers: { Cookie: a.cookie } });
    expect(user.status).toBe(200);
    expect(user.data.id).toBe(memberA.userId);
  });

  it('a same-member refresh succeeds and sets only the session cookie (US2 AS-2, FR-016)', async () => {
    const a = await loginSession(memberA.username, memberA.password);
    const res = await bff.post('/bff-api/auth/refresh', {}, { headers: { Cookie: a.cookie } });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    const live = ((res.headers['set-cookie'] as string[] | undefined) ?? []).filter((c) => !/Max-Age=0/.test(c));
    expect(live.map((c) => c.split('=')[0])).toEqual(['mcm_session_id']);
  });
});
