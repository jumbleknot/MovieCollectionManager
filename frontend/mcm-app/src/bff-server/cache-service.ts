/**
 * Redis cache service (T-024)
 * Handles session state, user profile caching, and rate-limit counters.
 * Uses ioredis for Redis connectivity.
 *
 * TTLs:
 *   - Session state: 10 minutes (600s)
 *   - User profile: 5 minutes (300s)
 *   - Rate-limit counters: per-endpoint windows (see rate-limiter.ts)
 */

import { env } from '@/config/env';
import type { Session, UserProfile } from '@/types/auth';
import { AuthError, AuthErrorCode } from '@/types/errors';

// ─── TTL constants ─────────────────────────────────────────────────────────────

const PROFILE_TTL_SECONDS = 300;      // 5 minutes

/**
 * Session key TTL = remaining absolute lifetime (009 finding #3).
 *
 * The Redis TTL must be a backstop ≥ the configured idle/absolute policy, never
 * shorter, or it silently caps the real timeout (the previous fixed 600s capped
 * the 30-min idle / 24-h absolute windows at 10 min). Idle/absolute expiry is
 * still enforced in getValidSession (the authority); this only keeps the key
 * alive long enough for that policy to apply. Floored at 1s for an
 * already-expired session.
 */
function sessionTtlSeconds(session: Session): number {
  const remainingMs = session.expiresAt - Date.now();
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

// ─── Key builders ──────────────────────────────────────────────────────────────

const sessionKey = (sessionId: string) => `session:${sessionId}`;
const profileKey = (userId: string) => `profile:${userId}`;
const userSessionsKey = (userId: string) => `user-sessions:${userId}`;
const rateLimitKey = (endpoint: string, identifier: string) =>
  `rate-limit:${endpoint}:${identifier}`;

// ─── Redis client (lazy init) ──────────────────────────────────────────────────

let redisClient: RedisLike | null = null;

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, expiryMode: 'EX', exSeconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  smembers(key: string): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<void>;
  srem(key: string, ...members: string[]): Promise<void>;
  scard(key: string): Promise<number>;
  quit(): Promise<void>;
}

async function getRedis(): Promise<RedisLike> {
  if (redisClient) return redisClient;

  try {
    // Dynamic require to avoid bundling ioredis on the client (synchronous require is interceptable by Jest mocks)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: Redis } = require('ioredis') as { default: new (url: string) => RedisLike };
    redisClient = new Redis(env.redisUrl);
    return redisClient;
  } catch {
    throw new AuthError(AuthErrorCode.UNKNOWN, 'Cache service unavailable', 503);
  }
}

// ─── Session cache ─────────────────────────────────────────────────────────────

export async function cacheSession(session: Session): Promise<void> {
  const redis = await getRedis();
  const ttl = sessionTtlSeconds(session);
  await redis.set(sessionKey(session.sessionId), JSON.stringify(session), 'EX', ttl);
  await redis.sadd(userSessionsKey(session.userId), session.sessionId);
  await redis.expire(userSessionsKey(session.userId), ttl);
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const redis = await getRedis();
  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    // Corrupt/truncated value (009 FR-021): treat as no session, fail-safe, and
    // drop the bad key rather than throwing an unhandled SyntaxError.
    await redis.del(sessionKey(sessionId)).catch(() => {});
    return null;
  }
}

export async function deleteSession(sessionId: string, userId: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(sessionKey(sessionId));
  await redis.srem(userSessionsKey(userId), sessionId);
}

export async function getUserSessionIds(userId: string): Promise<string[]> {
  const redis = await getRedis();
  return redis.smembers(userSessionsKey(userId));
}

export async function getUserSessionCount(userId: string): Promise<number> {
  const redis = await getRedis();
  return redis.scard(userSessionsKey(userId));
}

export async function updateSessionActivity(sessionId: string, now: number): Promise<void> {
  const redis = await getRedis();
  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) return;

  let session: Session;
  try {
    session = JSON.parse(raw) as Session;
  } catch {
    await redis.del(sessionKey(sessionId)).catch(() => {});
    return;
  }
  session.lastActivityAt = now;
  await redis.set(sessionKey(sessionId), JSON.stringify(session), 'EX', sessionTtlSeconds(session));
}

// ─── User profile cache ────────────────────────────────────────────────────────

export async function cacheUserProfile(profile: UserProfile): Promise<void> {
  const redis = await getRedis();
  await redis.set(profileKey(profile.id), JSON.stringify(profile), 'EX', PROFILE_TTL_SECONDS);
}

export async function getCachedUserProfile(userId: string): Promise<UserProfile | null> {
  const redis = await getRedis();
  const raw = await redis.get(profileKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserProfile;
  } catch {
    // Corrupt cached profile (009 FR-021): treat as a cache miss.
    await redis.del(profileKey(userId)).catch(() => {});
    return null;
  }
}

export async function invalidateUserProfile(userId: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(profileKey(userId));
}

// ─── Rate limit counters ───────────────────────────────────────────────────────

/**
 * Increment a rate-limit counter and set TTL on first increment.
 * Returns the updated count.
 */
export async function incrementRateLimit(
  endpoint: string,
  identifier: string,
  windowSeconds: number,
): Promise<number> {
  const redis = await getRedis();
  const key = rateLimitKey(endpoint, identifier);
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    return count;
  } catch {
    throw new AuthError(AuthErrorCode.UNKNOWN, 'Cache service unavailable', 503);
  }
}

export async function getRateLimitCount(endpoint: string, identifier: string): Promise<number> {
  const redis = await getRedis();
  const key = rateLimitKey(endpoint, identifier);
  const raw = await redis.get(key);
  return raw ? parseInt(raw, 10) : 0;
}
