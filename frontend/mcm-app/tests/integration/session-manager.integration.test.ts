/**
 * session-manager integration tests (T007) — US2.
 *
 * Exercises the BFF session module against REAL Redis (db 1) — no mocking
 * (constitution v1.3.0). Redis state is asserted directly via redis-test-client,
 * which shares db 1 with the module under test (REDIS_URL pinned to db 1 in
 * tests/integration/setup/env.ts before any module loads — T004a).
 *
 * Actual session-manager exports: createSession(userId), getValidSession(sessionId),
 * terminateSession(sessionId, userId), terminateAllSessions(userId),
 * getActiveSessionCount(userId), touchSession(sessionId). (No getSession/deleteSession.)
 */
import { randomUUID } from 'node:crypto';
import {
  createSession,
  getValidSession,
  terminateSession,
  getActiveSessionCount,
} from '@/bff-server/session-manager';
import { cacheSession } from '@/bff-server/cache-service';
import { env } from '@/config/env';
import type { Session } from '@/types/auth';
import {
  redisExists,
  redisTtl,
  redisFlushDb,
  closeRedis,
} from './helpers/redis-test-client';

const sessionKey = (id: string) => `session:${id}`;

describe('session-manager — integration (real Redis db 1)', () => {
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

  it('creates a session in Redis with a positive TTL (US2-AC1)', async () => {
    const userId = randomUUID();
    const session = await createSession(userId);

    expect(await redisExists(sessionKey(session.sessionId))).toBe(true);
    const ttl = await redisTtl(sessionKey(session.sessionId));
    // cache-service persists sessions with a 600s safety TTL; idle/absolute
    // timeouts are enforced separately by getValidSession via timestamps.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('retrieves the stored session payload (US2-AC2)', async () => {
    const userId = randomUUID();
    const created = await createSession(userId);

    const fetched = await getValidSession(created.sessionId);
    expect(fetched).not.toBeNull();
    expect(fetched!.sessionId).toBe(created.sessionId);
    expect(fetched!.userId).toBe(userId);
    expect(fetched!.expiresAt).toBe(created.expiresAt);
  });

  it('returns null for an idle-expired session (US2-AC3)', async () => {
    // Seed a session whose lastActivityAt is older than the idle timeout, then
    // confirm getValidSession evicts it and returns null (real idle-timeout path).
    const userId = randomUUID();
    const now = Date.now();
    const stale: Session = {
      sessionId: randomUUID(),
      userId,
      createdAt: now - env.sessionIdleTimeoutMs - 60_000,
      lastActivityAt: now - env.sessionIdleTimeoutMs - 60_000,
      expiresAt: now + env.sessionAbsoluteTimeoutMs,
    };
    await cacheSession(stale);

    expect(await getValidSession(stale.sessionId)).toBeNull();
    expect(await redisExists(sessionKey(stale.sessionId))).toBe(false);
  });

  it('returns null for an absolute-expired session', async () => {
    const userId = randomUUID();
    const now = Date.now();
    const expired: Session = {
      sessionId: randomUUID(),
      userId,
      createdAt: now - env.sessionAbsoluteTimeoutMs - 60_000,
      lastActivityAt: now,
      expiresAt: now - 1_000,
    };
    await cacheSession(expired);

    expect(await getValidSession(expired.sessionId)).toBeNull();
  });

  it('evicts the oldest session when MAX_CONCURRENT_SESSIONS is exceeded (US2-AC4)', async () => {
    const userId = randomUUID();
    const max = env.maxConcurrentSessions;

    const first = await createSession(userId);
    // small spread so lastActivityAt differs; create exactly `max` more → total max+1
    for (let i = 0; i < max; i++) {
      await createSession(userId);
    }

    // count is capped at the max; the oldest (first) session was evicted
    expect(await getActiveSessionCount(userId)).toBe(max);
    expect(await redisExists(sessionKey(first.sessionId))).toBe(false);
    expect(await getValidSession(first.sessionId)).toBeNull();
  });

  it('removes a terminated session from Redis (US2-AC5)', async () => {
    const userId = randomUUID();
    const session = await createSession(userId);

    await terminateSession(session.sessionId, userId);

    expect(await redisExists(sessionKey(session.sessionId))).toBe(false);
    expect(await getValidSession(session.sessionId)).toBeNull();
  });
});
