/**
 * Per-user run gate and on-demand rate limit (feature 073, T034 — FR-012/013; US2-AC3/AC4).
 *
 * AGAINST REAL Redis (db 1).
 *
 * THE CONCURRENCY CASE MUST BE GENUINELY CONCURRENT. A sequential "acquire, then acquire again"
 * proves only that a held slot blocks a later caller — which a non-atomic check-then-set also
 * passes, every time. Issuing the acquires together and awaiting them together is the only
 * shape that can distinguish the two.
 *
 * THE TTL IS NOT A DETAIL. Without it a run that dies mid-way — the process killed, the
 * container restarted — locks that user out of backing up for ever, and nothing in the UI
 * would say why. The expiry case asserts the lockout is self-healing.
 */
import { randomUUID } from 'node:crypto';

import {
  acquireUserRunSlot,
  releaseUserRunSlot,
  checkBackupRunRateLimit,
  BACKUP_RUN_SLOT_TTL_SECONDS,
} from '@/bff-server/backup-runner';
import { RateLimitError } from '@/types/errors';

import { redisExists, redisTtl, redisFlushDb, closeRedis } from './helpers/redis-test-client';

const slotKey = (userId: string) => `backup-lock:running:${userId}`;

beforeAll(async () => {
  await redisFlushDb();
});

afterAll(async () => {
  await closeRedis();
});

describe('one run per user at a time (FR-013)', () => {
  it('grants the slot to exactly ONE of several genuinely concurrent callers', async () => {
    const userId = `gate-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => acquireUserRunSlot(userId)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('lets the SAME user start again once the slot is released', async () => {
    const userId = `gate-release-${randomUUID()}`;
    expect(await acquireUserRunSlot(userId)).toBe(true);
    expect(await acquireUserRunSlot(userId)).toBe(false);
    await releaseUserRunSlot(userId);
    expect(await acquireUserRunSlot(userId)).toBe(true);
  });

  it('does not gate one user behind ANOTHER user’s run', async () => {
    // The key is per-user. A shared key would make one long-running backup block everybody,
    // and the symptom would be intermittent 409s with no pattern a user could see.
    const a = `gate-a-${randomUUID()}`;
    const b = `gate-b-${randomUUID()}`;
    expect(await acquireUserRunSlot(a)).toBe(true);
    expect(await acquireUserRunSlot(b)).toBe(true);
  });

  it('carries a TTL, so a crashed run cannot lock a user out permanently', async () => {
    const userId = `gate-ttl-${randomUUID()}`;
    await acquireUserRunSlot(userId);
    const ttl = await redisTtl(slotKey(userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(BACKUP_RUN_SLOT_TTL_SECONDS);
  });

  it('the slot really does expire on its own', async () => {
    // Proven with a real expiry rather than by reading the TTL back: a TTL that is SET but on
    // the wrong key, or reset by a later write, still reads correctly above.
    const userId = `gate-expiry-${randomUUID()}`;
    await acquireUserRunSlot(userId, 1);
    expect(await acquireUserRunSlot(userId, 1)).toBe(false);
    await new Promise((r) => setTimeout(r, 1300));
    expect(await redisExists(slotKey(userId))).toBe(false);
    expect(await acquireUserRunSlot(userId, 1)).toBe(true);
  });

  it('releasing a slot the user does not hold is harmless', async () => {
    await expect(releaseUserRunSlot(`gate-absent-${randomUUID()}`)).resolves.toBeUndefined();
  });
});

describe('on-demand rate limit (FR-012)', () => {
  it('allows a reasonable burst and then refuses, with a retry hint', async () => {
    const userId = `rate-${randomUUID()}`;
    let refused: RateLimitError | null = null;
    for (let i = 0; i < 40; i += 1) {
      try {
        await checkBackupRunRateLimit(userId);
      } catch (err) {
        refused = err as RateLimitError;
        break;
      }
    }
    expect(refused).toBeInstanceOf(RateLimitError);
    // A 429 with no retry hint tells a user to try again at random, which is how a rate limit
    // becomes a source of load rather than a control on it.
    expect(refused!.retryAfter ?? (refused as unknown as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts per user, so one user cannot exhaust another’s allowance', async () => {
    const busy = `rate-busy-${randomUUID()}`;
    for (let i = 0; i < 40; i += 1) {
      try {
        await checkBackupRunRateLimit(busy);
      } catch {
        break;
      }
    }
    // A different user is unaffected.
    await expect(checkBackupRunRateLimit(`rate-quiet-${randomUUID()}`)).resolves.toBeUndefined();
  });
});
