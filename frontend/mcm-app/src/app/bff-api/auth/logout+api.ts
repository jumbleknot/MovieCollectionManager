/**
 * BFF /logout endpoint (T-106; server-held tokens since feature 085).
 *
 * Ends the caller's OWN session. The session reference comes from the `mcm_session_id` cookie,
 * which is the credential now that the client holds no token (FR-016). For a live session it
 * revokes the SERVER-HELD refresh token at Keycloak, ends the member's Keycloak SSO sessions, and
 * deletes the session with its tokens (FR-020); then clears the cookies. Only the current session
 * is terminated.
 */

import { revokeToken, logoutUserSessions } from '@/bff-server/keycloak';
import { readLiveSessionWithTokens, terminateSession } from '@/bff-server/session-manager';
import { openSessionTokens } from '@/bff-server/session-tokens';
import { buildClearAuthCookies, extractSessionId } from '@/bff-server/auth';
import { checkLogoutRateLimit, extractClientIp } from '@/bff-server/rate-limiter';
import { logger } from '@/bff-server/logger';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { AuthErrorCode, AuthError } from '@/types/errors';

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(() => _post(req));
}

async function _post(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const ip = extractClientIp(headers);

    await checkLogoutRateLimit(ip);

    const sessionId = extractSessionId(headers);
    let userId: string | undefined;
    if (sessionId) {
      const live = await readLiveSessionWithTokens(sessionId).catch(() => null);
      if (live && 'session' in live) {
        userId = live.session.userId;
        let refreshToken: string | undefined;
        try {
          refreshToken = live.tokensRaw ? openSessionTokens(live.session, live.tokensRaw).refreshToken : undefined;
        } catch {
          // An unopenable record still names a live session of this owner; end it regardless.
        }
        // logoutUserSessions uses the Admin API, which ends the SSO user session itself (not just
        // the client/token session), so the browser's Keycloak cookie is stale on the next sign-in.
        await Promise.allSettled([
          refreshToken ? revokeToken(refreshToken, 'refresh_token') : Promise.resolve(),
          logoutUserSessions(userId),
          terminateSession(sessionId, userId),
        ]);
      }
    }

    // Emit ONE Set-Cookie header per cleared cookie. Joining them into a single
    // comma-separated Set-Cookie value is invalid — the browser parses only the first
    // cookie, leaving mcm_refresh_token (Path=/bff-api/auth/refresh) and mcm_session_id
    // uncleared. Mirror the refresh endpoint, which appends each cookie separately.
    const responseHeaders = securityHeaders();
    for (const cookie of buildClearAuthCookies()) {
      responseHeaders.append('Set-Cookie', cookie);
    }

    logger.audit('logout', { userId, ip });

    return Response.json(
      { success: true, message: 'Logged out successfully.' },
      { status: 200, headers: responseHeaders },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.statusCode, headers: securityHeaders() },
      );
    }
    logger.error('logout: unhandled error', { action: 'logout_error', error: err });
    return Response.json(
      { error: 'Logout failed.', code: AuthErrorCode.UNKNOWN_ERROR },
      { status: 500, headers: securityHeaders() },
    );
  }
}
