/**
 * BFF /logout endpoint (T-106)
 * Invalidates the session in Redis, revokes the refresh token in Keycloak,
 * and clears auth cookies. Only terminates the current session.
 */

import { ExpoRequest, ExpoResponse } from 'expo-router/server';
import { revokeToken } from '@/bff-server/keycloak';
import { terminateSession } from '@/bff-server/session-manager';
import { buildClearAuthCookies, extractSessionId, requireAuth } from '@/bff-server/auth';
import { AuthErrorCode, AuthError } from '@/types/errors';

export async function POST(req: ExpoRequest): Promise<ExpoResponse> {
  try {
    // Auth is best-effort on logout — even if token is expired, clear cookies
    let sessionId = extractSessionId(req.headers);
    let refreshToken: string | undefined;

    try {
      await requireAuth(req.headers);
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
    if (sessionId) {
      await terminateSession(sessionId).catch(() => {});
    }

    // Revoke refresh token in Keycloak
    if (refreshToken) {
      await revokeToken(refreshToken, 'refresh_token').catch(() => {});
    }

    const clearCookies = buildClearAuthCookies();

    return ExpoResponse.json(
      { success: true, message: 'Logged out successfully.' },
      {
        status: 200,
        headers: { 'Set-Cookie': clearCookies.join(', ') },
      },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return ExpoResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    console.error('[BFF /logout]', err);
    return ExpoResponse.json(
      { error: 'Logout failed.', code: AuthErrorCode.UNKNOWN_ERROR },
      { status: 500 },
    );
  }
}
