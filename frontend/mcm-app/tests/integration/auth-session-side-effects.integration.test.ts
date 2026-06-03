/**
 * Unauthenticated session side-effect integration tests (009 #9) — US2.
 *
 * An unauthenticated request carrying a victim's session id must cause NO change
 * to that session: the profile/session-status path must not evict it, and logout
 * must not terminate it. Exercised in-process against the real route handlers and
 * REAL Redis (db 1) — no mocking.
 */
import { randomUUID } from 'node:crypto';
import { GET as USER_GET } from '@/app/bff-api/auth/user+api';
import { POST as LOGOUT_POST } from '@/app/bff-api/auth/logout+api';
import { cacheSession } from '@/bff-server/cache-service';
import { env } from '@/config/env';
import type { Session } from '@/types/auth';
import { redisExists, redisFlushDb, closeRedis } from './helpers/redis-test-client';

const sessionKey = (id: string) => `session:${id}`;

function reqWithSessionCookie(sessionId: string): Request {
  return {
    url: 'http://localhost/bff-api/auth/endpoint',
    headers: new Headers({ cookie: `mcm_session_id=${sessionId}` }),
  } as unknown as Request;
}

describe('unauthenticated session side-effects — integration (real Redis db 1)', () => {
  beforeAll(async () => {
    await redisFlushDb();
  });
  afterAll(async () => {
    await redisFlushDb();
    await closeRedis();
  });
  beforeEach(async () => {
    await redisFlushDb();
  });

  it('GET /user without auth returns 401 and does NOT evict a forged (idle-expired) victim session', async () => {
    const now = Date.now();
    // Idle-expired: pre-fix, validateSessionTimeout ran before auth and would
    // evict this; post-fix, requireAuth rejects first and it is left untouched.
    const victim: Session = {
      sessionId: randomUUID(),
      userId: randomUUID(),
      createdAt: now - env.sessionIdleTimeoutMs - 60_000,
      lastActivityAt: now - env.sessionIdleTimeoutMs - 60_000,
      expiresAt: now + env.sessionAbsoluteTimeoutMs,
    };
    await cacheSession(victim);

    const res = await USER_GET(reqWithSessionCookie(victim.sessionId));

    expect(res.status).toBe(401);
    expect(await redisExists(sessionKey(victim.sessionId))).toBe(true);
  });

  it('POST /logout without auth does NOT terminate a forged victim session', async () => {
    const now = Date.now();
    const victim: Session = {
      sessionId: randomUUID(),
      userId: randomUUID(),
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + env.sessionAbsoluteTimeoutMs,
    };
    await cacheSession(victim);

    await LOGOUT_POST(reqWithSessionCookie(victim.sessionId));

    // Cookie-clearing is best-effort, but the victim's server session must remain.
    expect(await redisExists(sessionKey(victim.sessionId))).toBe(true);
  });
});
