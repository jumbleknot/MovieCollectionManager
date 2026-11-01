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
import { logger } from '@/bff-server/logger';
import type { Session } from '@/types/auth';

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

  // Enforce the concurrent-session cap even under simultaneous logins (009 FR-018):
  // the pre-add count check is TOCTOU-racy, so after adding, trim the oldest until
  // the set is at/below the cap. The no-progress break guards against an infinite
  // loop from stale set members whose session objects are already gone.
  let count = await getUserSessionCount(userId);
  while (count > MAX_SESSIONS) {
    await evictOldestSession(userId);
    const next = await getUserSessionCount(userId);
    if (next >= count) break;
    count = next;
  }

  return session;
}

export type LiveSessionResult =
  | { session: Session }
  | { expired: 'absolute' | 'idle'; userId: string }
  | { expired: 'missing' };

/**
 * Read a session and say why it is not live, when it is not (feature 085 US5, FR-012).
 *
 * Absolute is checked BEFORE idle, so a session past its maximum length is reported as that even
 * when it is also idle. An expired session is deleted here. The distinction is the point: the
 * previous `getValidSession` returned null for both, and every caller reported "idle".
 */
export async function readLiveSession(sessionId: string): Promise<LiveSessionResult> {
  const session = await getSession(sessionId);
  if (!session) return { expired: 'missing' };

  const now = Date.now();
  if (now > session.expiresAt) {
    await deleteSession(session.sessionId, session.userId);
    return { expired: 'absolute', userId: session.userId };
  }
  if (now - session.lastActivityAt > env.sessionIdleTimeoutMs) {
    await deleteSession(session.sessionId, session.userId);
    return { expired: 'idle', userId: session.userId };
  }
  return { session };
}

/**
 * The live session, or null when it is missing or expired (either way). Callers that must report
 * WHY use `readLiveSession`.
 */
export async function getValidSession(sessionId: string): Promise<Session | null> {
  const result = await readLiveSession(sessionId);
  return 'session' in result ? result.session : null;
}

/**
 * Slide the idle window of an active session. Called where idle expiry is enforced: on
 * `/bff-api/auth/user` (via validateSessionTimeout) and `/bff-api/auth/refresh` — not on every
 * authenticated request (feature 085 FR-013 records where it actually happens).
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

  // 052 FR-001. This cap used to fire in complete silence, which made "it never fires" and "it fires
  // constantly" indistinguishable from outside the process — `app-e2e` was diagnosed twice from the
  // configuration alone for exactly that reason, and the BFF log had zero hits for `evict`,
  // `concurrent` or `session`. Evicting someone's session is a security-relevant action; it should
  // have said so regardless of what needed measuring.
  //
  // The evicted session id is deliberately NOT logged. Passing it under the key `sessionId` would
  // have been redacted to the constant "[REDACTED]" by the logger — conveying nothing — while still
  // tripping `mcm-no-token-logging`, which matches on the key NAME. Passing it under any other key
  // would have leaked it. There is no version of logging it that is both useful and safe, and the
  // counts this event exists to produce do not need it. (Caught by the SAST gate on run 1605.)
  logger.audit('session_evicted', {
    userId,
    activeSessions: validSessions.length,
    maxSessions: MAX_SESSIONS,
  });
}

/**
 * Get the count of active sessions for a user (for display/audit).
 */
export async function getActiveSessionCount(userId: string): Promise<number> {
  return getUserSessionCount(userId);
}
