/**
 * BFF /refresh endpoint (T-066; server-held tokens since feature 085).
 *
 * Renews the SERVER-HELD tokens of the caller's OWN session (FR-021). The session comes from the
 * `mcm_session_id` cookie and the refresh token from the session — nothing in the request can name
 * another session or carry a credential, so the ownership guarantee (FR-006) holds by construction;
 * the renewal still checks the renewed token's owner (session-tokens.ts). The client's agent and
 * axios interceptors call this on a 401, unchanged; the response re-sets only the session cookie.
 *
 * Enforces per-session rate limiting.
 */

import { checkRefreshRateLimit } from '@/bff-server/rate-limiter';
import {
  readLiveSessionWithTokens,
  terminateSession,
  touchSession,
} from '@/bff-server/session-manager';
import {
  ensureFreshTokens,
  openSessionTokens,
  type SessionTokens,
} from '@/bff-server/session-tokens';
import { buildAuthCookies, buildClearAuthCookies, extractSessionId } from '@/bff-server/auth';
import { authErrorHeaders } from '@/bff-server/mc-api-error';
import { logger } from '@/bff-server/logger';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { AuthErrorCode, AuthError, RateLimitError } from '@/types/errors';

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(() => _post(req));
}

function refused(code: AuthErrorCode, error: string): Response {
  const headers = securityHeaders();
  for (const cookie of buildClearAuthCookies()) headers.append('Set-Cookie', cookie);
  return Response.json({ error, code }, { status: 401, headers });
}

async function _post(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const sessionId = extractSessionId(headers);
    if (!sessionId) {
      return Response.json(
        { error: 'No active session.', code: AuthErrorCode.SESSION_NOT_FOUND },
        { status: 401, headers: securityHeaders() },
      );
    }

    await checkRefreshRateLimit(sessionId);

    const live = await readLiveSessionWithTokens(sessionId);
    if ('expired' in live)
      return refused(AuthErrorCode.SESSION_EXPIRED, 'Session expired or not found.');

    const { session, tokensRaw } = live;
    let held: SessionTokens;
    try {
      if (!tokensRaw) throw new Error('session holds no tokens');
      held = openSessionTokens(session, tokensRaw);
    } catch {
      // A session from before 085, or a record that does not open for it: never migrated (FR-022).
      await terminateSession(session.sessionId, session.userId).catch(() => {});
      return refused(AuthErrorCode.REFRESH_TOKEN_INVALID, 'Refresh token missing.');
    }

    const renewed = await ensureFreshTokens(session, held, { force: true });
    await touchSession(session);

    const responseHeaders = securityHeaders();
    for (const cookie of buildAuthCookies(sessionId)) responseHeaders.append('Set-Cookie', cookie);
    return Response.json(
      {
        success: true,
        expiresIn: Math.max(0, Math.round((renewed.accessExpiresAt - Date.now()) / 1000)),
      },
      { status: 200, headers: responseHeaders },
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return Response.json(
        {
          error: 'Too many refresh requests.',
          code: AuthErrorCode.RATE_LIMIT_EXCEEDED,
          retryAfter: err.retryAfter,
        },
        { status: 429, headers: securityHeaders({ 'Retry-After': String(err.retryAfter) }) },
      );
    }
    if (err instanceof AuthError) {
      if (err.statusCode === 401) return refused(err.code, err.message);
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.statusCode, headers: authErrorHeaders(err) },
      );
    }
    logger.error('refresh: unhandled error', { action: 'refresh_error', error: err });
    return Response.json(
      { error: 'Token refresh failed.', code: AuthErrorCode.UNKNOWN_ERROR },
      { status: 500, headers: securityHeaders() },
    );
  }
}
