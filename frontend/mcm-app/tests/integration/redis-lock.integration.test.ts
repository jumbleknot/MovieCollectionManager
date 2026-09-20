/**
 * Redis leader lock integration tests (feature 073, T010 — FR-018).
 *
 * AGAINST REAL REDIS (db 1), and deliberately not in the unit tier where tasks.md placed it.
 * All three properties this lock must have — a concurrent acquire has exactly one winner, the
 * lock expires on its own, and a release by a non-holder does nothing — are properties of
 * Redis's SET NX EX and of an atomic compare-and-delete. A unit test with a mocked client would
 * assert those semantics against a fake that I would also have written, which proves that my
 * model of Redis agrees with itself. The repo already draws this line the same way: there is a
 * mocked `unit-tests/rate-limiter.test.ts` for the decision logic AND a
 * `rate-limiter.integration.test.ts` for the Redis behaviour.
 *
 * WHAT THIS LOCK IS FOR, and what it is NOT. It stops every BFF instance scanning every tick.
 * It is an OPTIMISATION. The correctness guarantee for exactly-once is the single-document
 * atomic claim in T050/T051, because this lock's safety rests on a TTL guess and a TTL guess is
 * not a guarantee. A passing test here must not be read as "scheduled runs cannot double-fire".
 */
import { randomUUID } from 'node:crypto';

import { acquireLock, releaseLock, withLeaderLock } from '@/bff-server/redis-lock';

import { redisExists, redisTtl, redisFlushDb, closeRedis } from './helpers/redis-test-client';

const LOCK_KEY = (name: string) => `backup-lock:${name}`;

beforeAll(async () => {
  await redisFlushDb();
});

afterAll(async () => {
  await closeRedis();
});

describe('acquireLock', () => {
  it('grants the lock to exactly ONE of several genuinely concurrent callers', async () => {
    const name = `tick-${randomUUID()}`;
    // Issued together and awaited together. A sequential loop would prove only that a held lock
    // blocks a later caller, which is a different and much weaker statement than "the race has
    // one winner".
    const results = await Promise.all(
      Array.from({ length: 8 }, () => acquireLock(name, randomUUID(), 30)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('sets a TTL, so a holder that dies cannot wedge the lock for ever', async () => {
    const name = `ttl-${randomUUID()}`;
    expect(await acquireLock(name, randomUUID(), 30)).toBe(true);
    const ttl = await redisTtl(LOCK_KEY(name));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('expires on its own, and the next caller then wins', async () => {
    const name = `expiry-${randomUUID()}`;
    expect(await acquireLock(name, randomUUID(), 1)).toBe(true);
    expect(await acquireLock(name, randomUUID(), 1)).toBe(false);
    // Real Redis expiry cannot be fast-forwarded by fake timers, so this waits out a 1s TTL.
    await new Promise((r) => setTimeout(r, 1300));
    expect(await redisExists(LOCK_KEY(name))).toBe(false);
    expect(await acquireLock(name, randomUUID(), 5)).toBe(true);
  });
});

describe('releaseLock', () => {
  it('releases a lock held by the SAME instance', async () => {
    const name = `own-${randomUUID()}`;
    const holder = randomUUID();
    expect(await acquireLock(name, holder, 30)).toBe(true);
    expect(await releaseLock(name, holder)).toBe(true);
    expect(await redisExists(LOCK_KEY(name))).toBe(false);
  });

  it('is a NO-OP when another instance holds the lock', async () => {
    // The failure this prevents: instance A's run overruns its TTL, B acquires, A finishes and
    // releases — deleting B's lock while B is mid-run, so a third instance starts a second
    // concurrent pass. A blind DEL would do exactly that.
    const name = `foreign-${randomUUID()}`;
    const holder = randomUUID();
    expect(await acquireLock(name, holder, 30)).toBe(true);
    expect(await releaseLock(name, randomUUID())).toBe(false);
    expect(await redisExists(LOCK_KEY(name))).toBe(true);
  });

  it('is a no-op for a lock that is not held at all', async () => {
    expect(await releaseLock(`absent-${randomUUID()}`, randomUUID())).toBe(false);
  });
});

describe('withLeaderLock', () => {
  it('runs the body and releases afterwards', async () => {
    const name = `run-${randomUUID()}`;
    const result = await withLeaderLock(name, 30, async () => 'did-the-work');
    expect(result).toEqual({ leader: true, value: 'did-the-work' });
    expect(await redisExists(LOCK_KEY(name))).toBe(false);
  });

  it('reports non-leadership WITHOUT running the body — a normal outcome, not an error', async () => {
    const name = `busy-${randomUUID()}`;
    expect(await acquireLock(name, randomUUID(), 30)).toBe(true);
    const body = jest.fn(async () => 'should-not-run');
    const result = await withLeaderLock(name, 30, body);
    expect(result).toEqual({ leader: false });
    expect(body).not.toHaveBeenCalled();
  });

  it('releases the lock even when the body throws', async () => {
    // Otherwise one failing tick silences the scheduler for a whole TTL, and the symptom is
    // "backups stopped happening" with nothing in the logs saying why.
    const name = `throws-${randomUUID()}`;
    await expect(
      withLeaderLock(name, 30, async () => {
        throw new Error('body blew up');
      }),
    ).rejects.toThrow('body blew up');
    expect(await redisExists(LOCK_KEY(name))).toBe(false);
  });
});
