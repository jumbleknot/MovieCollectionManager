/**
 * Redis test client (T003).
 *
 * Direct Redis inspection for integration-test assertions, on database index 1
 * (isolated from the running development BFF on db 0). The modules under test
 * also connect to db 1 in the integration environment because
 * tests/integration/setup/env.ts sets REDIS_URL=redis://localhost:6379/1 before
 * any module loads (T004a) — so the module-under-test and this inspection helper
 * share the same database.
 */
import Redis from 'ioredis';

const redis = new Redis({ host: 'localhost', port: 6379, db: 1 });

export async function redisGet(key: string): Promise<string | null> {
  return redis.get(key);
}

/** TTL in seconds: -2 = key missing, -1 = key exists but has no TTL. */
export async function redisTtl(key: string): Promise<number> {
  return redis.ttl(key);
}

export async function redisExists(key: string): Promise<boolean> {
  return (await redis.exists(key)) === 1;
}

export async function redisDel(key: string): Promise<void> {
  await redis.del(key);
}

export async function redisKeys(pattern: string): Promise<string[]> {
  return redis.keys(pattern);
}

/** Flush db 1 ONLY — used in beforeAll/beforeEach. Never touches db 0. */
export async function redisFlushDb(): Promise<void> {
  await redis.flushdb();
}

/** Close the connection — call in afterAll so Jest exits cleanly. */
export async function closeRedis(): Promise<void> {
  await redis.quit();
}
