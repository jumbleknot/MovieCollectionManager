/**
 * BFF /login endpoint (T-065)
 * Exchanges authorization code + PKCE code verifier for tokens with Keycloak.
 * Returns user profile in response and sets JWT in HTTP-only cookies.
 */

import { exchangeCodeForTokens, getUserById, decodeJwtPayload } from '@/bff-server/keycloak';
import { validateJwt, extractRoles, validateAtHash } from '@/bff-server/token-service';
import { checkLoginRateLimit, extractClientIp } from '@/bff-server/rate-limiter';
import { createSession, getActiveSessionCount } from '@/bff-server/session-manager';
import { buildAuthCookies } from '@/bff-server/auth';
import { logger } from '@/bff-server/logger';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { AuthErrorCode, AuthError, RateLimitError } from '@/types/errors';
import { env } from '@/config/env';

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(() => _post(req));
}

async function _post(req: Request): Promise<Response> {
  const headers = Object.fromEntries(req.headers.entries());
  const ip = extractClientIp(headers);

  try {
    await checkLoginRateLimit(ip);

    const body = await req.json() as {
      code?: string;
      codeVerifier?: string;
      redirectUri?: string;
    };

    if (!body.code || !body.codeVerifier || !body.redirectUri) {
      return Response.json(
        { error: 'Missing required fields: code, codeVerifier, redirectUri', code: AuthErrorCode.INVALID_INPUT },
        { status: 400, headers: securityHeaders() },
      );
    }

    const tokens = await exchangeCodeForTokens(body.code, body.codeVerifier, body.redirectUri);

    // Validate ID token claims
    const idPayload = decodeJwtPayload(tokens.id_token);
    const now = Math.floor(Date.now() / 1000);

    if (!idPayload || idPayload.exp < now) {
      return Response.json(
        { error: 'ID token expired.', code: AuthErrorCode.TOKEN_EXPIRED },
        { status: 401, headers: securityHeaders() },
      );
    }

    // Validate at_hash against access token
    if (idPayload.at_hash) {
      const atHashValid = await validateAtHash(idPayload, tokens.access_token);
      if (!atHashValid) {
        return Response.json(
          { error: 'ID token validation failed.', code: AuthErrorCode.TOKEN_INVALID },
          { status: 401, headers: securityHeaders() },
        );
      }
    }

    // Validate access token signature
    const { payload: accessPayload } = await validateJwt(tokens.access_token);
    const roles = extractRoles(accessPayload, env.keycloakClientId);

    if (!roles.includes('mc-user') && !roles.includes('mc-admin')) {
      logger.audit('login_role_denied', { userId: accessPayload.sub, ip, roles });
      return Response.json(
        { error: 'Account does not have required role.', code: AuthErrorCode.FORBIDDEN },
        { status: 403, headers: securityHeaders() },
      );
    }

    // Check account status
    const userId: string = accessPayload.sub;
    const keycloakUser = await getUserById(userId).catch((err: unknown) => {
      if (err instanceof AuthError) throw err;
      logger.error('login: keycloak user lookup failed', { action: 'login_error', ip, error: err });
      throw new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'Failed to retrieve user account.', 503);
    });

    if (!keycloakUser.enabled) {
      return Response.json(
        { error: 'Account is disabled.', code: AuthErrorCode.ACCOUNT_DISABLED },
        { status: 403, headers: securityHeaders() },
      );
    }

    // Concurrent session enforcement — eviction handled inside createSession
    await getActiveSessionCount(userId).catch((err: unknown) => {
      logger.warn('login: session count check failed (non-fatal)', { action: 'login', userId, error: err });
    });

    const session = await createSession(userId).catch((err: unknown) => {
      if (err instanceof AuthError) throw err;
      logger.error('login: session creation failed', { action: 'login_error', ip, error: err });
      throw new AuthError(AuthErrorCode.UNKNOWN, 'Session creation failed. Please try again.', 503);
    });
    const cookies = buildAuthCookies(
      tokens.access_token,
      tokens.refresh_token,
      session.sessionId,
      tokens.expires_in,
      tokens.refresh_expires_in,
    );

    const profile = {
      id: userId,
      username: keycloakUser.username,
      email: keycloakUser.email,
      firstName: keycloakUser.firstName,
      lastName: keycloakUser.lastName,
      roles,
      emailVerified: keycloakUser.emailVerified,
    };

    const responseHeaders = securityHeaders({ 'X-Session-Id': session.sessionId });
    for (const cookie of cookies) {
      responseHeaders.append('Set-Cookie', cookie);
    }

    logger.audit('login', { userId, ip, roles });

    return Response.json(
      { success: true, user: profile },
      { status: 200, headers: responseHeaders },
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      logger.audit('login_rate_limited', { ip });
      return Response.json(
        { error: 'Too many login attempts. Try again later.', code: AuthErrorCode.RATE_LIMIT_EXCEEDED, retryAfter: err.retryAfter },
        { status: 429, headers: securityHeaders({ 'Retry-After': String(err.retryAfter) }) },
      );
    }
    if (err instanceof AuthError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.statusCode, headers: securityHeaders() },
      );
    }
    logger.error('login: unhandled error', { action: 'login_error', ip, error: err });
    return Response.json(
      { error: 'Authentication failed.', code: AuthErrorCode.UNKNOWN_ERROR },
      { status: 500, headers: securityHeaders() },
    );
  }
}
