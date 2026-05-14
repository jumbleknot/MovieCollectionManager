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
import { AuthErrorCode, AuthError, RateLimitError } from '@/types/errors';
import { env } from '@/config/env';

export async function POST(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const ip = extractClientIp(headers);
    const ua = req.headers.get('user-agent') ?? 'unknown';
    const earlyLog = `[BFF /login RECV] ${new Date().toISOString()} ip=${ip} ua=${ua.slice(0,50)}\n`;
    console.log(earlyLog.trim());
    require('fs').appendFileSync('C:/Users/Steve/bff-login.log', earlyLog, 'utf8');
    await checkLoginRateLimit(ip);

    const body = await req.json() as {
      code?: string;
      codeVerifier?: string;
      redirectUri?: string;
    };
    const logLine = `[BFF /login BODY] ${new Date().toISOString()} code=${body.code?.slice(0,12)} cv=${body.codeVerifier?.slice(0,8)} ru=${body.redirectUri}\n`;
    console.log(logLine.trim());
    require('fs').appendFileSync('C:/Users/Steve/bff-login.log', logLine, 'utf8');

    if (!body.code || !body.codeVerifier || !body.redirectUri) {
      return Response.json(
        { error: 'Missing required fields: code, codeVerifier, redirectUri', code: AuthErrorCode.INVALID_INPUT },
        { status: 400 },
      );
    }

    const tokens = await exchangeCodeForTokens(body.code, body.codeVerifier, body.redirectUri);
    console.log('[BFF /login] exchangeCodeForTokens OK, validating tokens...');

    // Validate ID token claims
    const idPayload = decodeJwtPayload(tokens.id_token);
    const now = Math.floor(Date.now() / 1000);

    if (!idPayload || idPayload.exp < now) {
      console.log('[BFF /login] FAIL: ID token expired or unparseable exp=' + idPayload?.exp + ' now=' + now);
      return Response.json(
        { error: 'ID token expired.', code: AuthErrorCode.TOKEN_EXPIRED },
        { status: 401 },
      );
    }
    console.log('[BFF /login] ID token OK, at_hash=' + idPayload.at_hash);

    // Validate at_hash against access token
    if (idPayload.at_hash) {
      const atHashValid = await validateAtHash(idPayload, tokens.access_token);
      if (!atHashValid) {
        console.log('[BFF /login] FAIL: at_hash validation failed');
        return Response.json(
          { error: 'ID token validation failed.', code: AuthErrorCode.TOKEN_INVALID },
          { status: 401 },
        );
      }
      console.log('[BFF /login] at_hash OK');
    }

    // Validate access token signature
    console.log('[BFF /login] validating JWT signature...');
    const { payload: accessPayload } = await validateJwt(tokens.access_token);
    console.log('[BFF /login] JWT signature OK, extracting roles...');
    const roles = extractRoles(accessPayload, env.keycloakClientId);

    if (!roles.includes('mc-user') && !roles.includes('mc-admin')) {
      return Response.json(
        { error: 'Account does not have required role.', code: AuthErrorCode.FORBIDDEN },
        { status: 403 },
      );
    }

    // Check account status
    const userId: string = accessPayload.sub;
    const keycloakUser = await getUserById(userId).catch((err: unknown) => {
      if (err instanceof AuthError) throw err;
      console.error('[BFF /login] getUserById failed:', err);
      throw new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'Failed to retrieve user account.', 503);
    });

    if (!keycloakUser.enabled) {
      return Response.json(
        { error: 'Account is disabled.', code: AuthErrorCode.ACCOUNT_DISABLED },
        { status: 403 },
      );
    }

    // Concurrent session enforcement — eviction handled inside createSession
    await getActiveSessionCount(userId).catch(() => { /* non-fatal */ });

    const session = await createSession(userId).catch((err: unknown) => {
      if (err instanceof AuthError) throw err;
      console.error('[BFF /login] createSession failed:', err);
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

    const responseHeaders = new Headers({ 'X-Session-Id': session.sessionId });
    for (const cookie of cookies) {
      responseHeaders.append('Set-Cookie', cookie);
    }

    return Response.json(
      { success: true, user: profile },
      { status: 200, headers: responseHeaders },
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return Response.json(
        { error: 'Too many login attempts. Try again later.', code: AuthErrorCode.RATE_LIMIT_EXCEEDED, retryAfter: err.retryAfter },
        { status: 429, headers: { 'Retry-After': String(err.retryAfter) } },
      );
    }
    if (err instanceof AuthError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    console.error('[BFF /login]', err);
    return Response.json(
      { error: 'Authentication failed.', code: AuthErrorCode.UNKNOWN_ERROR },
      { status: 500 },
    );
  }
}
