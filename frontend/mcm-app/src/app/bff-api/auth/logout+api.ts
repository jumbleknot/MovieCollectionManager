/**
 * BFF /logout endpoint (T-106)
 * Invalidates the session in Redis, revokes the refresh token in Keycloak,
 * and clears auth cookies. Only terminates the current session.
 */

import { revokeToken, logoutUserSessions } from '@/bff-server/keycloak';
import { terminateSession } from '@/bff-server/session-manager';
import { getSession } from '@/bff-server/cache-service';
import { buildClearAuthCookies, extractSessionId, parseCookies, requireAuth, REFRESH_TOKEN_COOKIE } from '@/bff-server/auth';
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

    // Cookie clearing is best-effort even if the token is expired, BUT server
    // session + IAM SSO termination must only happen for an AUTHENTICATED caller
    // acting on their OWN session (009 finding #9): an unauthenticated request
    // carrying a victim's X-Session-Id must not force-logout the victim.
    const sessionId = extractSessionId(headers);
    let refreshToken: string | undefined;

    let authUserId: string | undefined;
    try {
      const { payload } = await requireAuth(headers);
      authUserId = payload.sub;
    } catch {
      // Token missing/expired — proceed to clear cookies only; no termination.
    }

    // Extract refresh token from cookie
    const cookieHeader = req.headers.get('cookie') ?? '';
    refreshToken = parseCookies(cookieHeader)[REFRESH_TOKEN_COOKIE];

    // Terminate the caller's own current session only — never a foreign session id.
    let userId: string | undefined;
    if (authUserId && sessionId) {
      const session = await getSession(sessionId).catch(() => null);
      if (session && session.userId === authUserId) {
        userId = session.userId;
        await terminateSession(sessionId, session.userId).catch(() => {});
      }
    }

    // Revoke refresh token and terminate all Keycloak SSO sessions for the user.
    // logoutUserSessions uses the Admin API which actually ends the SSO user
    // session (not just the client/token session), so Chrome's SSO cookie becomes
    // stale on the next auth request.
    await Promise.allSettled([
      refreshToken ? revokeToken(refreshToken, 'refresh_token') : Promise.resolve(),
      userId ? logoutUserSessions(userId) : Promise.resolve(),
    ]);

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
