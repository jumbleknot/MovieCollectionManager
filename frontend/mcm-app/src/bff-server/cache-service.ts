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

const SESSION_TTL_SECONDS = 600;      // 10 minutes
const PROFILE_TTL_SECONDS = 300;      // 5 minutes

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
  set(key: string, value: string, exSeconds?: number): Promise<void>;
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
    // Dynamic import to avoid bundling ioredis on the client
    const { default: Redis } = await import('ioredis') as { default: new (url: string) => RedisLike };
    redisClient = new Redis(env.redisUrl);
    return redisClient;
  } catch {
    throw new AuthError(AuthErrorCode.UNKNOWN, 'Cache service unavailable', 503);
  }
}

// ─── Session cache ─────────────────────────────────────────────────────────────

export async function cacheSession(session: Session): Promise<void> {
  const redis = await getRedis();
  await redis.set(sessionKey(session.sessionId), JSON.stringify(session), SESSION_TTL_SECONDS);
  await redis.sadd(userSessionsKey(session.userId), session.sessionId);
  await redis.expire(userSessionsKey(session.userId), SESSION_TTL_SECONDS);
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const redis = await getRedis();
  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) return null;
  return JSON.parse(raw) as Session;
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

  const session = JSON.parse(raw) as Session;
  session.lastActivityAt = now;
  await redis.set(sessionKey(sessionId), JSON.stringify(session), SESSION_TTL_SECONDS);
}

// ─── User profile cache ────────────────────────────────────────────────────────

export async function cacheUserProfile(profile: UserProfile): Promise<void> {
  const redis = await getRedis();
  await redis.set(profileKey(profile.id), JSON.stringify(profile), PROFILE_TTL_SECONDS);
}

export async function getCachedUserProfile(userId: string): Promise<UserProfile | null> {
  const redis = await getRedis();
  const raw = await redis.get(profileKey(userId));
  if (!raw) return null;
  return JSON.parse(raw) as UserProfile;
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
  const count = await redis.incr(key);
  if (count === 1) {
    // First request in this window — set the expiry
    await redis.expire(key, windowSeconds);
  }
  return count;
}

export async function getRateLimitCount(endpoint: string, identifier: string): Promise<number> {
  const redis = await getRedis();
  const key = rateLimitKey(endpoint, identifier);
  const raw = await redis.get(key);
  return raw ? parseInt(raw, 10) : 0;
}
