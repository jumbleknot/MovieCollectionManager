/**
 * Session timeout BFF middleware (T-028a).
 *
 * Enforces the idle and absolute timeouts for the session named by the `mcm_session_id` COOKIE, on
 * the routes that call it — `/bff-api/auth/user`, which the client calls at startup and on
 * resume. It is NOT applied to every authenticated request (feature 085 FR-013): the other routes
 * authenticate the access token alone, whose own short lifetime bounds them.
 */

import { readLiveSession, touchSession } from '@/bff-server/session-manager';
import { logger } from '@/bff-server/logger';
import { AuthError, AuthErrorCode } from '@/types/errors';

/**
 * Throw unless the session is live, with the true reason when it is not; slide the idle window
 * when it is. The reason is audited (feature 085 US5, FR-012): an absolute expiry is never
 * reported as inactivity.
 */
export async function validateSessionTimeout(sessionId: string | null): Promise<void> {
  if (!sessionId) {
    throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'No session found', 401);
  }

  const result = await readLiveSession(sessionId);

  if ('session' in result) {
    await touchSession(sessionId);
    return;
  }

  if (result.expired === 'missing') {
    throw new AuthError(AuthErrorCode.SESSION_NOT_FOUND, 'Your session could not be found. Please log in again.', 401);
  }

  logger.audit('session_expired', { userId: result.userId, reason: result.expired });
  if (result.expired === 'absolute') {
    throw new AuthError(
      AuthErrorCode.SESSION_ABSOLUTE_TIMEOUT,
      'Your session has ended for security purposes. Please log in again.',
      401,
    );
  }
  throw new AuthError(
    AuthErrorCode.SESSION_IDLE_TIMEOUT,
    'Your session has ended due to inactivity. Please log in again.',
    401,
  );
}
