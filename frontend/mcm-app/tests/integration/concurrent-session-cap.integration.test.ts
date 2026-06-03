/**
 * Concurrent-session-cap integration test (009 FR-018) — US6.
 *
 * Simultaneous logins for one user must never leave the active-session count
 * above the configured maximum (the pre-add count check is TOCTOU-racy; the
 * post-add trim enforces the cap). Asserted against REAL Redis (db 1).
 */
import { randomUUID } from 'node:crypto';
import { createSession, getActiveSessionCount } from '@/bff-server/session-manager';
import { env } from '@/config/env';
import { redisFlushDb, closeRedis } from './helpers/redis-test-client';

describe('concurrent session cap — integration (real Redis db 1)', () => {
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

  it('never exceeds MAX_CONCURRENT_SESSIONS under simultaneous logins', async () => {
    const userId = randomUUID();
    const max = env.maxConcurrentSessions;

    // Fire max + 5 logins concurrently to exercise the race.
    await Promise.all(Array.from({ length: max + 5 }, () => createSession(userId)));

    expect(await getActiveSessionCount(userId)).toBeLessThanOrEqual(max);
  });
});
