/**
 * BFF Redis client (db 0) for HTTP-level integration tests.
 *
 * The running BFF process connects to Redis database index 0 (its `.env.local`
 * REDIS_URL). HTTP-level tests that need a session the BFF can see (logout,
 * refresh guard paths) must seed/inspect db 0 — NOT db 1 (which the in-process
 * module-level tests use). This helper talks to db 0 directly, mirroring the
 * key format produced by `cache-service.ts`.
 *
 * Sessions seeded here are for ephemeral `int-*` test users and are removed in
 * teardown. This necessarily shares db 0 with the dev BFF because the BFF runs
 * on db 0; keys are namespaced by the unique test session id / user id.
 */
import Redis from 'ioredis';
import type { Session } from '@/types/auth';

const redis = new Redis({ host: 'localhost', port: 6379, db: 0 });

const sessionKey = (id: string) => `session:${id}`;
const userSessionsKey = (userId: string) => `user-sessions:${userId}`;

/** Seed a session into the BFF's db 0, matching cache-service's key format + 600s TTL. */
export async function bffSeedSession(session: Session): Promise<void> {
  await redis.set(sessionKey(session.sessionId), JSON.stringify(session), 'EX', 600);
  await redis.sadd(userSessionsKey(session.userId), session.sessionId);
  await redis.expire(userSessionsKey(session.userId), 600);
}

export async function bffSessionExists(sessionId: string): Promise<boolean> {
  return (await redis.exists(sessionKey(sessionId))) === 1;
}

/** Remove any residual session keys for a test user (teardown safety net). */
export async function bffCleanupUser(userId: string): Promise<void> {
  const ids = await redis.smembers(userSessionsKey(userId));
  if (ids.length) await redis.del(...ids.map(sessionKey));
  await redis.del(userSessionsKey(userId));
}

export async function closeBffRedis(): Promise<void> {
  await redis.quit();
}

/** Every raw value the BFF stores for a session: its record and its sealed tokens (feature 085). */
export async function bffRawSessionValues(sessionId: string): Promise<{ record: string | null; tokens: string | null }> {
  const [record, tokens] = await redis.mget(sessionKey(sessionId), `session-tokens:${sessionId}`);
  return { record: record ?? null, tokens: tokens ?? null };
}

/**
 * Age a session's server-held access token by rewriting the CLEAR `accessExpiresAt` of its sealed
 * record (data-model.md: the expiry times sit outside the ciphertext so a test can do exactly this
 * without the key). The next request that needs the token must renew it.
 */
export async function bffAgeSessionAccessToken(sessionId: string): Promise<void> {
  const key = `session-tokens:${sessionId}`;
  const raw = await redis.get(key);
  if (!raw) throw new Error(`bffAgeSessionAccessToken: no tokens for session ${sessionId}`);
  const ttl = await redis.ttl(key);
  await redis.set(key, JSON.stringify({ ...JSON.parse(raw), accessExpiresAt: 0 }), 'EX', Math.max(ttl, 60));
}

/** Put another session's sealed tokens into this session — a tampered/corrupted store (FR-006). */
export async function bffCopySessionTokens(fromSessionId: string, toSessionId: string): Promise<void> {
  const raw = await redis.get(`session-tokens:${fromSessionId}`);
  if (!raw) throw new Error(`bffCopySessionTokens: no tokens for session ${fromSessionId}`);
  await redis.set(`session-tokens:${toSessionId}`, raw, 'EX', 600);
}
