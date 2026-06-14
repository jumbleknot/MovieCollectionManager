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
const agentCostKey = (identifier: string) => `agent-cost:${identifier}`;
const agentUiStateKey = (userId: string) => `agent-ui-state:${userId}`;
const agentThreadOwnerKey = (threadId: string) => `agent-thread-owner:${threadId}`;
const agentImportFileKey = (userId: string) => `agent-import-file:${userId}`;

// ─── Redis client (lazy init) ──────────────────────────────────────────────────

let redisClient: RedisLike | null = null;

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, expiryMode: 'EX', exSeconds: number): Promise<unknown>;
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    exSeconds: number,
    setMode: 'NX',
  ): Promise<string | null>;
  del(...keys: string[]): Promise<void>;
  incr(key: string): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
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

// ─── Agent cost budget (feature 012, FR-020a) ────────────────────────────────────

/**
 * Accrue an agent per-turn cost (integer micro-USD) against a fixed-window budget.
 * Cost is stored in micro-USD so the integer `incrby`/`expire`-on-first pattern can
 * be reused exactly (Redis floats would lose the first-add detection). The TTL is
 * set only on the first add of a window, so the budget resets after `windowSeconds`
 * rather than rolling forward indefinitely. Returns the updated total (micro-USD).
 */
export async function addAgentCostMicros(
  identifier: string,
  micros: number,
  windowSeconds: number,
): Promise<number> {
  const redis = await getRedis();
  const key = agentCostKey(identifier);
  try {
    const total = await redis.incrby(key, micros);
    if (total === micros) {
      await redis.expire(key, windowSeconds);
    }
    return total;
  } catch {
    throw new AuthError(AuthErrorCode.UNKNOWN, 'Cache service unavailable', 503);
  }
}

/** Read the accrued agent cost for an identifier (micro-USD; 0 when no budget window is open). */
export async function getAgentCostMicros(identifier: string): Promise<number> {
  const redis = await getRedis();
  const raw = await redis.get(agentCostKey(identifier));
  return raw ? parseInt(raw, 10) : 0;
}

// ─── Agent readable UI-state snapshot (feature 012 US3, R15) ──────────────────────

/** Default lifetime of a cached UI snapshot — short, refreshed on every screen focus. */
const AGENT_UI_STATE_TTL_SECONDS = 1800; // 30 min (matches session idle window)

/**
 * Store the per-user sanitized UI-state snapshot (US3/R15). The value is the already
 * allowlist-sanitized structural JSON (no PII/values/tokens — `sanitizeUiState` is the
 * sole sanitization point). The next `/run` reads it and bridges it to the gateway as
 * the `X-UI-Snapshot` header for "this"/current-screen resolution. Keyed per user (the
 * BFF maps userId → the active thread), short TTL, refreshed on each push.
 */
export async function setAgentUiSnapshot(userId: string, snapshotJson: string): Promise<void> {
  const redis = await getRedis();
  await redis.set(agentUiStateKey(userId), snapshotJson, 'EX', AGENT_UI_STATE_TTL_SECONDS);
}

/** Read the per-user sanitized UI-state snapshot JSON, or null when none is cached. */
export async function getAgentUiSnapshot(userId: string): Promise<string | null> {
  const redis = await getRedis();
  return redis.get(agentUiStateKey(userId));
}

// ─── Agent import-file reference (feature 014 US2) ────────────────────────────────────────

/** Lifetime of a pending import-file reference — matches the transient upload store TTL. */
const AGENT_IMPORT_FILE_TTL_SECONDS = 15 * 60;

/**
 * Stash the per-user import-file reference (`{handle, filename}` JSON) set by the import-upload
 * route. The reference names the transient upload store entry (an opaque handle — never file
 * bytes, never a credential); the next `/agent/run` reads + clears it and bridges it to the
 * gateway as the `X-Import-File` header for the import node (mirrors the UI-snapshot bridge).
 */
export async function setAgentImportFile(userId: string, referenceJson: string): Promise<void> {
  const redis = await getRedis();
  await redis.set(agentImportFileKey(userId), referenceJson, 'EX', AGENT_IMPORT_FILE_TTL_SECONDS);
}

/** Read the pending per-user import-file reference JSON, or null when none is set. */
export async function getAgentImportFile(userId: string): Promise<string | null> {
  const redis = await getRedis();
  return redis.get(agentImportFileKey(userId));
}

/** Clear the pending import-file reference (single-use per run, after it is read). */
export async function clearAgentImportFile(userId: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(agentImportFileKey(userId));
}

// ─── Agent thread ownership (implementation-review 2026-06-09 — cross-user resume guard) ──────

/**
 * Claim a (client-supplied) agent thread for a user, returning the OWNING user id.
 *
 * A CopilotKit `thread_id` is client-generated and otherwise unbound to the authenticated user,
 * so a user could resume another user's checkpointed thread and see that proposal's preview.
 * First use claims the thread atomically (`SET key user EX ttl NX`); any later caller reads back
 * the existing owner. The caller (`enforceAgentThreadOwnership`) rejects a mismatch with 403.
 * TTL is the session-scoped thread lifetime (threads expire with the session, per spec).
 */
export async function claimAgentThreadOwner(
  threadId: string,
  userId: string,
  ttlSeconds: number,
): Promise<string> {
  const redis = await getRedis();
  const key = agentThreadOwnerKey(threadId);
  try {
    const claimed = await redis.set(key, userId, 'EX', Math.max(1, ttlSeconds), 'NX');
    if (claimed) return userId; // 'OK' → this user just claimed an unowned thread
    const owner = await redis.get(key); // already owned — read the owner back
    return owner ?? userId; // race fallback: treat as ours rather than failing open
  } catch {
    throw new AuthError(AuthErrorCode.UNKNOWN, 'Cache service unavailable', 503);
  }
}
