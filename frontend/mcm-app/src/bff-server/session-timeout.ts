/**
 * Session timeout BFF middleware (T-028a)
 * Enforces 30-minute idle timeout and 24-hour absolute timeout on every
 * authenticated BFF request. Handles timeout detection server-side.
 */

import { getValidSession, touchSession } from '@/bff-server/session-manager';
import { AuthError, AuthErrorCode } from '@/types/errors';

// ─── Session timeout validation ────────────────────────────────────────────────

export interface SessionTimeoutResult {
  valid: boolean;
  reason?: 'idle' | 'absolute';
}

/**
 * Validate that the session identified by sessionId is still within its timeout bounds.
 * - Returns { valid: true } if the session is alive and updates lastActivityAt.
 * - Returns { valid: false, reason } if timed out.
 * - Throws if session does not exist (missing cookie / tampered).
 *
 * Call this after extractSessionId() and before any protected business logic.
 */
export async function validateSessionTimeout(sessionId: string | null): Promise<void> {
  if (!sessionId) {
    throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'No session found', 401);
  }

  const session = await getValidSession(sessionId);

  if (!session) {
    // Session expired — determine which timeout was hit (best-effort from timestamp absence)
    // The session was already cleaned up by getValidSession; signal idle timeout by default
    throw new AuthError(
      AuthErrorCode.SESSION_IDLE_TIMEOUT,
      'Your session has ended due to inactivity. Please log in again.',
      401,
    );
  }

  const now = Date.now();

  // Double-check absolute timeout (getValidSession may not distinguish)
  if (now > session.expiresAt) {
    throw new AuthError(
      AuthErrorCode.SESSION_ABSOLUTE_TIMEOUT,
      'Your session has ended for security purposes. Please log in again.',
      401,
    );
  }

  // Update activity timestamp (slide idle window)
  await touchSession(sessionId);
}
