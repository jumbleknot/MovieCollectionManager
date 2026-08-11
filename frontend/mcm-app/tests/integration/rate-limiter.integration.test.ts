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
import { checkLoginRateLimit, checkRefreshRateLimit } from '@/bff-server/rate-limiter';
import { RateLimitError, AuthErrorCode } from '@/types/errors';
import {
  redisExists,
  redisTtl,
  redisDel,
  redisFlushDb,
  closeRedis,
} from './helpers/redis-test-client';
import {
  captureLogEntries,
  auditEntriesFor,
  findCredentialLeaks,
} from './helpers/audit-log-capture';

const LOGIN_LIMIT = 5;
const counterKey = (id: string) => `rate-limit:login:${id}`;

// refresh rule: limit 2 / 30s per SESSION (see rate-limiter.ts RATE_LIMITS.refresh).
const REFRESH_LIMIT = 2;

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

  // ─── Feature 052: the refresh bucket, which had no voice at all ────────────────────────────────
  //
  // The refresh rule is keyed on the SESSION, and its capacity is 2 per 30 s. Every Playwright
  // worker in the web E2E suite presents the SAME session id (one shared `storageState`), so eight
  // workers share one bucket with room for two. Whether that is what reddened `app-e2e` is the
  // question feature 052 exists to answer — and it cannot be answered while the rejection is silent.

  it('emits a refresh_rate_limited audit event when the per-session bucket rejects', async () => {
    const sessionId = `test-${randomUUID()}`;

    for (let i = 0; i < REFRESH_LIMIT; i += 1) await checkRefreshRateLimit(sessionId);

    const entries = await captureLogEntries(async () => {
      await expect(checkRefreshRateLimit(sessionId)).rejects.toBeInstanceOf(RateLimitError);
    });

    expect(auditEntriesFor(entries, 'refresh_rate_limited')).toHaveLength(1);
  });

  // The denominator. A rejection count on its own cannot distinguish "the bucket never filled" from
  // "almost nothing refreshed at all", and those two imply opposite remedies. `checkRefreshRateLimit`
  // is the one function every refresh attempt passes through — it runs before the session is even
  // validated — so counting here makes refresh_429/refresh_total a ratio of like for like.
  it('emits a refresh_attempted audit event for every attempt, accepted or rejected', async () => {
    const sessionId = `test-${randomUUID()}`;

    const accepted = await captureLogEntries(async () => {
      await expect(checkRefreshRateLimit(sessionId)).resolves.toBeUndefined();
    });
    expect(auditEntriesFor(accepted, 'refresh_attempted')).toHaveLength(1);
    expect(auditEntriesFor(accepted, 'refresh_rate_limited')).toHaveLength(0);

    // Exhaust the bucket, then confirm a REJECTED attempt is still counted as an attempt.
    for (let i = 1; i < REFRESH_LIMIT; i += 1) await checkRefreshRateLimit(sessionId);

    const rejected = await captureLogEntries(async () => {
      await expect(checkRefreshRateLimit(sessionId)).rejects.toBeInstanceOf(RateLimitError);
    });
    expect(auditEntriesFor(rejected, 'refresh_attempted')).toHaveLength(1);
    expect(auditEntriesFor(rejected, 'refresh_rate_limited')).toHaveLength(1);
  });

  // FR-004 — the session id is the rate-limit key, so it is the obvious thing to log and the one
  // thing that must not appear. It is omitted entirely rather than redacted: under `sessionId` the
  // logger would render a useless constant while `mcm-no-token-logging` still blocked it by key
  // name, and under any other key it would leak.
  it('does not log the session id in either refresh event', async () => {
    const sessionId = `test-${randomUUID()}`;

    const entries = await captureLogEntries(async () => {
      for (let i = 0; i < REFRESH_LIMIT; i += 1) await checkRefreshRateLimit(sessionId);
      await expect(checkRefreshRateLimit(sessionId)).rejects.toBeInstanceOf(RateLimitError);
    });

    const refreshEvents = [
      ...auditEntriesFor(entries, 'refresh_attempted'),
      ...auditEntriesFor(entries, 'refresh_rate_limited'),
    ];
    expect(refreshEvents.length).toBeGreaterThan(0);
    for (const e of refreshEvents) expect(e).not.toHaveProperty('sessionId');
    expect(findCredentialLeaks(refreshEvents, [sessionId])).toEqual([]);
  });
});
