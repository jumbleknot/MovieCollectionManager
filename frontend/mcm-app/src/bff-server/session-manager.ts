/**
 * Session manager (T-028)
 * Tracks concurrent user sessions with a max-10-per-user policy.
 * When the limit is reached, the oldest inactive session is evicted.
 */

import { randomUUID } from 'crypto';
import {
  cacheSession,
  deleteSession,
  getSession,
  getUserSessionIds,
  getUserSessionCount,
} from '@/bff-server/cache-service';
import { env } from '@/config/env';
import type { Session } from '@/types/auth';
import { AuthError, AuthErrorCode } from '@/types/errors';

const MAX_SESSIONS = env.maxConcurrentSessions;

// ─── Session creation ──────────────────────────────────────────────────────────

/**
 * Create a new session for the given user.
 * Evicts the oldest inactive session if the max-concurrent-sessions limit is reached.
 * Returns the new Session object (persist session ID in a cookie).
 */
export async function createSession(userId: string): Promise<Session> {
  const now = Date.now();
  const sessionCount = await getUserSessionCount(userId);

  if (sessionCount >= MAX_SESSIONS) {
    await evictOldestSession(userId);
  }

  const session: Session = {
    sessionId: randomUUID(),
    userId,
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + env.sessionAbsoluteTimeoutMs,
  };

  await cacheSession(session);
  return session;
}

/**
 * Retrieve and validate a session by ID.
 * Returns null if the session does not exist or has expired.
 */
export async function getValidSession(sessionId: string): Promise<Session | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  const now = Date.now();

  // Check absolute timeout
  if (now > session.expiresAt) {
    await deleteSession(session.sessionId, session.userId);
    return null;
  }

  // Check idle timeout
  const idleElapsed = now - session.lastActivityAt;
  if (idleElapsed > env.sessionIdleTimeoutMs) {
    await deleteSession(session.sessionId, session.userId);
    return null;
  }

  return session;
}

/**
 * Update the lastActivityAt timestamp for an active session.
 * Called on each authenticated request to reset the idle timeout.
 */
export async function touchSession(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;

  session.lastActivityAt = Date.now();
  await cacheSession(session);
}

/**
 * Terminate a specific session (logout).
 */
export async function terminateSession(sessionId: string, userId: string): Promise<void> {
  await deleteSession(sessionId, userId);
}

/**
 * Terminate all sessions for a user (e.g., on password change or admin action).
 */
export async function terminateAllSessions(userId: string): Promise<void> {
  const sessionIds = await getUserSessionIds(userId);
  await Promise.all(sessionIds.map((sid) => deleteSession(sid, userId)));
}

// ─── Session eviction ──────────────────────────────────────────────────────────

async function evictOldestSession(userId: string): Promise<void> {
  const sessionIds = await getUserSessionIds(userId);

  const sessions = await Promise.all(
    sessionIds.map((id) => getSession(id)),
  );

  const validSessions = sessions.filter((s): s is Session => s !== null);

  if (validSessions.length === 0) return;

  // Evict the session with the oldest lastActivityAt
  validSessions.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
  const oldest = validSessions[0]!;

  await deleteSession(oldest.sessionId, userId);
}

/**
 * Get the count of active sessions for a user (for display/audit).
 */
export async function getActiveSessionCount(userId: string): Promise<number> {
  return getUserSessionCount(userId);
}
