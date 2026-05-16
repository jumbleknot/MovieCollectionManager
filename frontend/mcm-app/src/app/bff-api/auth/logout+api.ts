/**
 * BFF /logout endpoint (T-106)
 * Invalidates the session in Redis, revokes the refresh token in Keycloak,
 * and clears auth cookies. Only terminates the current session.
 */

import { revokeToken, logoutUserSessions } from '@/bff-server/keycloak';
import { terminateSession } from '@/bff-server/session-manager';
import { getSession } from '@/bff-server/cache-service';
import { buildClearAuthCookies, extractSessionId, requireAuth } from '@/bff-server/auth';
import { AuthErrorCode, AuthError } from '@/types/errors';

export async function POST(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    // Auth is best-effort on logout — even if token is expired, clear cookies
    const sessionId = extractSessionId(headers);
    let refreshToken: string | undefined;

    try {
      await requireAuth(headers);
    } catch {
      // Continue to clear cookies even if auth fails
    }

    // Extract refresh token from cookie
    const cookieHeader = req.headers.get('cookie') ?? '';
    refreshToken = cookieHeader
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('mcm_refresh_token='))
      ?.split('=')[1];

    // Terminate current session only (not other sessions)
    // Look up the session to get userId (needed by terminateSession and Admin logout)
    let userId: string | undefined;
    if (sessionId) {
      const session = await getSession(sessionId).catch(() => null);
      if (session) {
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

    const clearCookies = buildClearAuthCookies();

    return Response.json(
      { success: true, message: 'Logged out successfully.' },
      {
        status: 200,
        headers: { 'Set-Cookie': clearCookies.join(', ') },
      },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    console.error('[BFF /logout]', err);
    return Response.json(
      { error: 'Logout failed.', code: AuthErrorCode.UNKNOWN_ERROR },
      { status: 500 },
    );
  }
}
