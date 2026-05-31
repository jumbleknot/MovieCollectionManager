/**
 * rate-limiter integration tests (T015) — US6.
 *
 * Exercises the BFF rate limiter against REAL Redis (db 1) — no mocking
 * (constitution v1.3.0). The counter key and its TTL are asserted directly via
 * redis-test-client. Window reset is simulated by deleting the real counter key
 * (Jest fake timers cannot fast-forward a real Redis TTL).
 *
 * login rule: limit 5 / 60s per identifier (see rate-limiter.ts RATE_LIMITS.login).
 */
import { randomUUID } from 'node:crypto';
import { checkLoginRateLimit } from '@/bff-server/rate-limiter';
import { RateLimitError, AuthErrorCode } from '@/types/errors';
import {
  redisExists,
  redisTtl,
  redisDel,
  redisFlushDb,
  closeRedis,
} from './helpers/redis-test-client';

const LOGIN_LIMIT = 5;
const counterKey = (id: string) => `rate-limit:login:${id}`;

describe('rate-limiter — integration (real Redis db 1)', () => {
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

  it('returns 429 after the real counter exceeds the limit; key has a TTL (US6-AC1)', async () => {
    const ip = `test-${randomUUID()}`;

    // First LOGIN_LIMIT calls are allowed.
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      await expect(checkLoginRateLimit(ip)).resolves.toBeUndefined();
    }

    // The next call exceeds the limit and throws a typed 429.
    await expect(checkLoginRateLimit(ip)).rejects.toMatchObject({
      code: AuthErrorCode.RATE_LIMIT_EXCEEDED,
      statusCode: 429,
    });
    await expect(checkLoginRateLimit(ip)).rejects.toBeInstanceOf(RateLimitError);

    // The real Redis counter key exists with a positive TTL (window).
    expect(await redisExists(counterKey(ip))).toBe(true);
    const ttl = await redisTtl(counterKey(ip));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('accepts requests again after the counter window resets (US6-AC2)', async () => {
    const ip = `test-${randomUUID()}`;

    for (let i = 0; i < LOGIN_LIMIT; i++) await checkLoginRateLimit(ip);
    await expect(checkLoginRateLimit(ip)).rejects.toBeInstanceOf(RateLimitError);

    // Simulate window expiry by clearing the real counter key (cannot fast-forward
    // a real Redis TTL with fake timers).
    await redisDel(counterKey(ip));

    await expect(checkLoginRateLimit(ip)).resolves.toBeUndefined();
  });
});
