/**
 * Unauthenticated session side-effect integration tests (009 #9) — US2.
 *
 * An unauthenticated request NAMING a victim's session must cause NO change to that session: the
 * profile path must not evict it, and logout must not terminate it. Exercised in-process against
 * the real route handlers and REAL Redis (db 1) — no mocking.
 *
 * PREMISE UPDATED by feature 085 (the guard was failing because its premise changed, so it is
 * updated at the cause, not deleted). Before 085 a session reference was not a credential — the
 * token cookie was — so a caller could present a victim's session id next to their OWN token, and
 * 009 #9 made that change nothing. Since 085 the `mcm_session_id` COOKIE is the only credential
 * (the tokens are server-held), and it is read from the cookie ALONE. So the attack this guards
 * against is now a victim's session id supplied any other way — the `X-Session-Id` header the
 * original finding named — and that must still change nothing. An idle-expired session presented
 * as the cookie is refused as idle; removing a dead session is its expiry, not a side effect.
 */
import { randomUUID } from 'node:crypto';
import { GET as USER_GET } from '@/app/bff-api/auth/user+api';
import { POST as LOGOUT_POST } from '@/app/bff-api/auth/logout+api';
import { cacheSession } from '@/bff-server/cache-service';
import { env } from '@/config/env';
import type { Session } from '@/types/auth';
import { redisExists, redisFlushDb, closeRedis } from './helpers/redis-test-client';

const sessionKey = (id: string) => `session:${id}`;

function reqNamingSessionInHeader(sessionId: string): Request {
  return {
    url: 'http://localhost/bff-api/auth/endpoint',
    headers: new Headers({ 'x-session-id': sessionId }),
  } as unknown as Request;
}

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
    // Idle-expired: pre-009, validateSessionTimeout ran before auth and would evict this. Named in a
    // header it is not a credential, so nothing reads it and it is left untouched.
    const victim: Session = {
      sessionId: randomUUID(),
      userId: randomUUID(),
      createdAt: now - env.sessionIdleTimeoutMs - 60_000,
      lastActivityAt: now - env.sessionIdleTimeoutMs - 60_000,
      expiresAt: now + env.sessionAbsoluteTimeoutMs,
    };
    await cacheSession(victim);

    const res = await USER_GET(reqNamingSessionInHeader(victim.sessionId));

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

    await LOGOUT_POST(reqNamingSessionInHeader(victim.sessionId));

    // Cookie-clearing is best-effort, but the victim's server session must remain.
    expect(await redisExists(sessionKey(victim.sessionId))).toBe(true);
  });

  it('an idle-expired session presented as THE cookie is refused as idle — it is dead, not a victim', async () => {
    const now = Date.now();
    const idle: Session = {
      sessionId: randomUUID(),
      userId: randomUUID(),
      createdAt: now - env.sessionIdleTimeoutMs - 60_000,
      lastActivityAt: now - env.sessionIdleTimeoutMs - 60_000,
      expiresAt: now + env.sessionAbsoluteTimeoutMs,
    };
    await cacheSession(idle);

    const res = await USER_GET(reqWithSessionCookie(idle.sessionId));

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('SESSION_IDLE_TIMEOUT');
  });
});
