/**
 * BFF /login endpoint (T-065)
 * Exchanges authorization code + PKCE code verifier for tokens with Keycloak.
 * Returns user profile in response and sets JWT in HTTP-only cookies.
 */

import { ExpoRequest, ExpoResponse } from 'expo-router/server';
import { exchangeCodeForTokens, getUserById, decodeJwtPayload } from '@/bff-server/keycloak';
import { validateJwt, extractRoles, validateAtHash } from '@/bff-server/token-service';
import { checkLoginRateLimit, extractClientIp } from '@/bff-server/rate-limiter';
import { createSession, getActiveSessionCount } from '@/bff-server/session-manager';
import { buildAuthCookies } from '@/bff-server/auth';
import { AuthErrorCode, AuthError, RateLimitError } from '@/types/errors';
import { env } from '@/config/env';

export async function POST(req: ExpoRequest): Promise<ExpoResponse> {
  try {
    const ip = extractClientIp(req.headers);
    await checkLoginRateLimit(ip);

    const body = await req.json() as {
      code?: string;
      codeVerifier?: string;
      redirectUri?: string;
    };

    if (!body.code || !body.codeVerifier || !body.redirectUri) {
      return ExpoResponse.json(
        { error: 'Missing required fields: code, codeVerifier, redirectUri', code: AuthErrorCode.INVALID_INPUT },
        { status: 400 },
      );
    }

    const tokens = await exchangeCodeForTokens(body.code, body.codeVerifier, body.redirectUri);

    // Validate ID token claims
    const idPayload = decodeJwtPayload(tokens.id_token);
    const now = Math.floor(Date.now() / 1000);

    if (!idPayload || idPayload.exp < now) {
      return ExpoResponse.json(
        { error: 'ID token expired.', code: AuthErrorCode.TOKEN_EXPIRED },
        { status: 401 },
      );
    }

    // Validate at_hash against access token
    if (idPayload.at_hash) {
      const atHashValid = await validateAtHash(idPayload, tokens.access_token);
      if (!atHashValid) {
        return ExpoResponse.json(
          { error: 'ID token validation failed.', code: AuthErrorCode.TOKEN_INVALID },
          { status: 401 },
        );
      }
    }

    // Validate access token signature
    const accessPayload = await validateJwt(tokens.access_token);
    const roles = extractRoles(accessPayload, env.keycloakClientId);

    if (!roles.includes('mc-user') && !roles.includes('mc-admin')) {
      return ExpoResponse.json(
        { error: 'Account does not have required role.', code: AuthErrorCode.FORBIDDEN },
        { status: 403 },
      );
    }

    // Check account status
    const userId: string = accessPayload.sub;
    const keycloakUser = await getUserById(userId);

    if (!keycloakUser.enabled) {
      return ExpoResponse.json(
        { error: 'Account is disabled.', code: AuthErrorCode.ACCOUNT_DISABLED },
        { status: 403 },
      );
    }

    // Concurrent session enforcement
    const activeSessions = await getActiveSessionCount(userId);
    if (activeSessions >= env.maxConcurrentSessions) {
      // Session eviction happens inside createSession
    }

    const sessionId = await createSession(userId);
    const cookies = buildAuthCookies(tokens.access_token, tokens.refresh_token, sessionId);

    const profile = {
      id: userId,
      username: keycloakUser.username,
      email: keycloakUser.email,
      firstName: keycloakUser.firstName,
      lastName: keycloakUser.lastName,
      roles,
      emailVerified: keycloakUser.emailVerified,
    };

    return ExpoResponse.json(
      { success: true, user: profile },
      {
        status: 200,
        headers: {
          'Set-Cookie': cookies.join(', '),
          'X-Session-Id': sessionId,
        },
      },
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return ExpoResponse.json(
        { error: 'Too many login attempts. Try again later.', code: AuthErrorCode.RATE_LIMIT_EXCEEDED, retryAfter: err.retryAfter },
        { status: 429, headers: { 'Retry-After': String(err.retryAfter) } },
      );
    }
    if (err instanceof AuthError) {
      return ExpoResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    console.error('[BFF /login]', err);
    return ExpoResponse.json(
      { error: 'Authentication failed.', code: AuthErrorCode.UNKNOWN_ERROR },
      { status: 500 },
    );
  }
}
