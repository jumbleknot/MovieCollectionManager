/**
 * agent-rate-limiter integration tests (T027) — FR-020a / SC-011.
 *
 * Exercises the agent request rate limit and the per-user/session cost ceiling
 * against REAL Redis (db 1) — no mocking (constitution v1.3.0). Counter/budget keys
 * and their TTLs are asserted directly via redis-test-client. Window reset is
 * simulated by deleting the real key (Jest fake timers cannot fast-forward a real
 * Redis TTL).
 *
 * Defaults (plan.md): 20 requests / 60 s per user; $0.50 / session cost ceiling.
 */
import { randomUUID } from 'node:crypto';
import {
  checkAgentRequestRateLimit,
  enforceAgentCostCeiling,
  recordAgentCost,
} from '@/bff-server/agent-rate-limiter';
import { RateLimitError, AuthErrorCode } from '@/types/errors';
import {
  redisGet,
  redisTtl,
  redisExists,
  redisDel,
  redisFlushDb,
  closeRedis,
} from './helpers/redis-test-client';

const REQUEST_LIMIT = 20;
const requestKey = (id: string) => `rate-limit:agent-run:${id}`;
const costKey = (id: string) => `agent-cost:${id}`;

describe('agent-rate-limiter — integration (real Redis db 1)', () => {
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

  it('allows REQUEST_LIMIT runs then returns 429; counter key has a positive TTL', async () => {
    const userId = `user-${randomUUID()}`;

    for (let i = 0; i < REQUEST_LIMIT; i++) {
      await expect(checkAgentRequestRateLimit(userId)).resolves.toBeUndefined();
    }
    await expect(checkAgentRequestRateLimit(userId)).rejects.toMatchObject({
      code: AuthErrorCode.RATE_LIMIT_EXCEEDED,
      statusCode: 429,
    });

    const ttl = await redisTtl(requestKey(userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('accepts runs again after the request window resets', async () => {
    const userId = `user-${randomUUID()}`;
    for (let i = 0; i < REQUEST_LIMIT; i++) await checkAgentRequestRateLimit(userId);
    await expect(checkAgentRequestRateLimit(userId)).rejects.toBeInstanceOf(RateLimitError);

    await redisDel(requestKey(userId)); // simulate window expiry
    await expect(checkAgentRequestRateLimit(userId)).resolves.toBeUndefined();
  });

  it('accrues per-turn cost in micro-USD and sets a TTL only on the first add', async () => {
    const userId = `user-${randomUUID()}`;

    await recordAgentCost(userId, 0.1);
    expect(await redisGet(costKey(userId))).toBe('100000');
    const firstTtl = await redisTtl(costKey(userId));
    expect(firstTtl).toBeGreaterThan(0);

    await recordAgentCost(userId, 0.15);
    expect(await redisGet(costKey(userId))).toBe('250000'); // $0.25 accrued
  });

  it('blocks the next turn once accrued cost reaches the ceiling (no action), then allows after reset', async () => {
    const userId = `user-${randomUUID()}`;

    // Below the $0.50 ceiling — allowed.
    await recordAgentCost(userId, 0.45);
    await expect(enforceAgentCostCeiling(userId)).resolves.toBeUndefined();

    // Reaches the ceiling — the pre-flight check throws 429 before any work.
    await recordAgentCost(userId, 0.1); // total $0.55 ≥ $0.50
    await expect(enforceAgentCostCeiling(userId)).rejects.toBeInstanceOf(RateLimitError);

    // Budget window reset — allowed again.
    await redisDel(costKey(userId));
    expect(await redisExists(costKey(userId))).toBe(false);
    await expect(enforceAgentCostCeiling(userId)).resolves.toBeUndefined();
  });
});
