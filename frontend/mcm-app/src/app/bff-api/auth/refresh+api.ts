/**
 * BFF /refresh endpoint (T-066)
 * Exchanges a refresh token for a new access token via Keycloak.
 * Enforces per-session rate limiting and updates Redis session cache.
 */

import { refreshTokens } from '@/bff-server/keycloak';
import { checkRefreshRateLimit } from '@/bff-server/rate-limiter';
import { touchSession, getValidSession } from '@/bff-server/session-manager';
import { buildAuthCookies, extractSessionId } from '@/bff-server/auth';
import { logger } from '@/bff-server/logger';
import { AuthErrorCode, AuthError, RateLimitError } from '@/types/errors';

export async function POST(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const sessionId = extractSessionId(headers);
    if (!sessionId) {
      return Response.json(
        { error: 'No active session.', code: AuthErrorCode.SESSION_NOT_FOUND },
        { status: 401 },
      );
    }

    await checkRefreshRateLimit(sessionId);

    const session = await getValidSession(sessionId);
    if (!session) {
      return Response.json(
        { error: 'Session expired or not found.', code: AuthErrorCode.SESSION_EXPIRED },
        { status: 401 },
      );
    }

    // Read refresh token from cookie
    const cookieHeader = req.headers.get('cookie') ?? '';
    const refreshToken = cookieHeader
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('mcm_refresh_token='))
      ?.split('=')[1];

    if (!refreshToken) {
      return Response.json(
        { error: 'Refresh token missing.', code: AuthErrorCode.REFRESH_TOKEN_INVALID },
        { status: 401 },
      );
    }

    const tokens = await refreshTokens(refreshToken);

    await touchSession(sessionId);

    const cookies = buildAuthCookies(
      tokens.access_token,
      tokens.refresh_token,
      sessionId,
      tokens.expires_in,
      tokens.refresh_expires_in,
    );

    const responseHeaders = new Headers();
    for (const cookie of cookies) {
      responseHeaders.append('Set-Cookie', cookie);
    }

    return Response.json(
      { success: true, expiresIn: tokens.expires_in },
      { status: 200, headers: responseHeaders },
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return Response.json(
        { error: 'Too many refresh requests.', code: AuthErrorCode.RATE_LIMIT_EXCEEDED, retryAfter: err.retryAfter },
        { status: 429, headers: { 'Retry-After': String(err.retryAfter) } },
      );
    }
    if (err instanceof AuthError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    logger.error('refresh: unhandled error', { action: 'refresh_error', error: err });
    return Response.json(
      { error: 'Token refresh failed.', code: AuthErrorCode.UNKNOWN_ERROR },
      { status: 500 },
    );
  }
}
