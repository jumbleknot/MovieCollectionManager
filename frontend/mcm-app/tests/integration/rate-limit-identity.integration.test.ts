/**
 * Rate-limit identity integration tests (009 #4) — US3.
 *
 * Exercises extractClientIp + the login limiter against REAL Redis (db 1).
 * Confirms the limit key is the non-spoofable right-most XFF hop behind a trusted
 * proxy, and that without a trusted proxy IP limiting is skipped (no shared
 * 'unknown' lockout bucket).
 */
import { extractClientIp, checkLoginRateLimit } from '@/bff-server/rate-limiter';
import { RateLimitError } from '@/types/errors';
import { redisExists, redisKeys, redisFlushDb, closeRedis } from './helpers/redis-test-client';

describe('rate-limit identity — integration (real Redis db 1)', () => {
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

  it('keys the login limit on the right-most XFF hop; rotating spoofed left entries still trips it', async () => {
    let limited = false;
    // 6 attempts > the 5/min login limit; each rotates the spoofable left entry
    // but keeps the same real peer (10.0.0.9) that the trusted proxy appended.
    for (let i = 0; i < 6; i++) {
      const ip = extractClientIp({ 'x-forwarded-for': `1.1.1.${i}, 10.0.0.9` }, true);
      try {
        await checkLoginRateLimit(ip);
      } catch (e) {
        if (e instanceof RateLimitError) limited = true;
      }
    }
    expect(limited).toBe(true);
    expect(await redisExists('rate-limit:login:10.0.0.9')).toBe(true);
    // The spoofed left entry was never used as a key.
    expect(await redisExists('rate-limit:login:1.1.1.0')).toBe(false);
  });

  it('skips IP limiting (no key, no throw) when not behind a trusted proxy', async () => {
    const ip = extractClientIp({ 'x-forwarded-for': '10.0.0.1' }, false);
    expect(ip).toBeNull();
    for (let i = 0; i < 10; i++) {
      await checkLoginRateLimit(ip); // must not throw
    }
    expect((await redisKeys('rate-limit:login:*')).length).toBe(0);
  });
});
