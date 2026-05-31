/**
 * /bff-api/auth/refresh integration tests (T010) — FR-012 guard paths.
 *
 * HTTP-level against the running BFF + real Redis (db 0). No mocking
 * (constitution v1.3.0).
 *
 * Happy-path token rotation is NOT tested here: /auth/refresh refreshes against
 * the production client (movie-collection-manager), whose refresh tokens are
 * obtainable only via the browser PKCE flow (the direct-grant test client must
 * never be enabled on the production client). It is covered by the feature-003
 * E2E flow — same rationale as the login code-exchange exclusion. The route still
 * has real integration coverage (the guard paths below), so the coverage gate is
 * satisfied without a new exclusion.
 */
import { randomUUID } from 'node:crypto';
import { createBffClient } from './helpers/bff-test-server';
import {
  bffSeedSession,
  bffCleanupUser,
  closeBffRedis,
} from './helpers/bff-redis-client';
import type { Session } from '@/types/auth';

const bff = createBffClient();

describe('/bff-api/auth/refresh — integration guard paths (real BFF + Redis)', () => {
  const seededUserIds: string[] = [];

  afterAll(async () => {
    for (const uid of seededUserIds) await bffCleanupUser(uid);
    await closeBffRedis();
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
