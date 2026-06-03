/**
 * Registration per-source rate-limit integration test (009 #8) — US3.
 *
 * Confirms the per-source (IP) registration throttle trips against REAL Redis
 * (db 1) regardless of the email used, so unique-email spam from one source is
 * bounded.
 */
import { checkRegisterIpRateLimit } from '@/bff-server/rate-limiter';
import { RateLimitError } from '@/types/errors';
import { redisExists, redisFlushDb, closeRedis } from './helpers/redis-test-client';

describe('register per-source rate limit — integration (real Redis db 1)', () => {
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

  it('throttles after the per-source limit regardless of email (009 #8)', async () => {
    let limited = false;
    // 21 attempts > the 20/day per-source limit, simulating unique-email spam.
    for (let i = 0; i < 21; i++) {
      try {
        await checkRegisterIpRateLimit('9.9.9.9');
      } catch (e) {
        if (e instanceof RateLimitError) limited = true;
      }
    }
    expect(limited).toBe(true);
    expect(await redisExists('rate-limit:register-ip:9.9.9.9')).toBe(true);
  });

  it('does not throw when there is no trusted client identity (null)', async () => {
    await expect(checkRegisterIpRateLimit(null)).resolves.toBeUndefined();
  });
});
