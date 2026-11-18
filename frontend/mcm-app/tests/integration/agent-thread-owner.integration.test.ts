/**
 * Agent thread-owner claim against REAL Redis (db 1) — spec 102 US3, item #975.
 *
 * `claimAgentThreadOwner` is one Lua script: claim when absent, refresh the TTL when the caller
 * owns it, and return the owner. A mocked client can only prove the script is CALLED, so what it
 * DOES is proven here, against the server that runs it.
 *
 * Time is fast-forwarded by shortening the key's TTL (`EXPIRE`), not by waiting: a claim with 5 s
 * left stands for "the old 24 h first-use TTL is nearly up".
 */
import { randomUUID } from 'node:crypto';
import { claimAgentThreadOwner } from '@/bff-server/cache-service';
import { closeRedis, redisExpire, redisGet, redisTtl } from './helpers/redis-test-client';

const TTL = 7200;
const key = (threadId: string) => `agent-thread-owner:${threadId}`;

describe('claimAgentThreadOwner — integration (real Redis db 1)', () => {
  afterAll(async () => {
    await closeRedis();
  });

  it('claims an unowned thread for the caller, with the full TTL', async () => {
    const thread = `it-${randomUUID()}`;
    await expect(claimAgentThreadOwner(thread, 'user-A', TTL)).resolves.toBe('user-A');
    expect(await redisGet(key(thread))).toBe('user-A');
    expect(await redisTtl(key(thread))).toBeGreaterThan(TTL - 5);
  });

  it("refreshes the owner's claim on use, so a thread in active use keeps its owner (US3-AC1)", async () => {
    const thread = `it-${randomUUID()}`;
    await claimAgentThreadOwner(thread, 'user-A', TTL);
    await redisExpire(key(thread), 5); // the first-use TTL is nearly up…
    await expect(claimAgentThreadOwner(thread, 'user-A', TTL)).resolves.toBe('user-A'); // …A uses it
    expect(await redisTtl(key(thread))).toBeGreaterThan(TTL - 5); // the window slid
  });

  it("another user's attempt neither takes the thread nor extends A's claim", async () => {
    const thread = `it-${randomUUID()}`;
    await claimAgentThreadOwner(thread, 'user-A', TTL);
    await redisExpire(key(thread), 30);
    await expect(claimAgentThreadOwner(thread, 'user-B', TTL)).resolves.toBe('user-A');
    expect(await redisGet(key(thread))).toBe('user-A');
    expect(await redisTtl(key(thread))).toBeLessThanOrEqual(30); // B's probe kept nothing alive
  });

  it('B is refused after the old TTL has REALLY passed, because A kept using the thread (US3-AC4)', async () => {
    const thread = `it-${randomUUID()}`;
    await claimAgentThreadOwner(thread, 'user-A', TTL);
    await redisExpire(key(thread), 1); // the first-use TTL has 1 s left…
    await claimAgentThreadOwner(thread, 'user-A', TTL); // …A uses the thread…
    await new Promise((resolve) => setTimeout(resolve, 1500)); // …and the old TTL passes for real
    await expect(claimAgentThreadOwner(thread, 'user-B', TTL)).resolves.toBe('user-A');
    expect(await redisGet(key(thread))).toBe('user-A');
  });
});
