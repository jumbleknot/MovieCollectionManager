/**
 * JWT validation middleware (T-025)
 * Server-side BFF middleware — extracts and validates JWTs from HTTP-only cookies.
 * Falls back to Authorization header for platforms without cookie support.
 */

import { env } from '@/config/env';
import { validateJwt, extractRoles } from '@/bff-server/token-service';
import { logger } from '@/bff-server/logger';
import type { JWTPayload, UserProfile } from '@/types/auth';
import { AuthError, AuthErrorCode, UnauthorizedError } from '@/types/errors';

// ─── Request extensions ────────────────────────────────────────────────────────
// In Expo Router API routes, ExpoRouterRequest/Response are used.
// We define a minimal augmented request type for BFF middleware usage.

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
  user?: UserProfile;
  tokenPayload?: JWTPayload;
  sessionId?: string;
}

// ─── Cookie name constants ─────────────────────────────────────────────────────

export const ACCESS_TOKEN_COOKIE = 'mcm_access_token';
export const REFRESH_TOKEN_COOKIE = 'mcm_refresh_token';
export const SESSION_ID_COOKIE = 'mcm_session_id';

// ─── Token extraction ──────────────────────────────────────────────────────────

function extractToken(headers: Record<string, string | string[] | undefined>): string | null {
  // 1. Try Authorization: Bearer <token> header (for fallback/testing)
  const authHeader = headers['authorization'];
  const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (authStr?.startsWith('Bearer ')) {
    return authStr.slice(7);
  }

  // 2. Try cookie (set as HTTP-only — accessible server-side)
  const cookieHeader = headers['cookie'];
  const cookieStr = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (cookieStr) {
    const cookies = parseCookies(cookieStr);
    if (cookies[ACCESS_TOKEN_COOKIE]) {
      return cookies[ACCESS_TOKEN_COOKIE];
    }
  }

  return null;
}

function parseCookies(cookieStr: string): Record<string, string> {
  return cookieStr.split(';').reduce(
    (acc, pair) => {
      const [key, ...rest] = pair.trim().split('=');
      if (key) {
        acc[key.trim()] = rest.join('=').trim();
      }
      return acc;
    },
    {} as Record<string, string>,
  );
}

// ─── Build UserProfile from JWT payload ────────────────────────────────────────

export function buildUserProfileFromPayload(payload: JWTPayload): UserProfile {
  const roles = extractRoles(payload, env.keycloakClientId);

  return {
    id: payload.sub,
    username: payload.preferred_username,
    email: payload.email,
    firstName: payload.given_name,
    lastName: payload.family_name,
    roles,
    emailVerified: payload.email_verified,
    accountStatus: 'active',
    createdAt: new Date(payload.iat * 1000).toISOString(),
  };
}

// ─── Auth middleware ───────────────────────────────────────────────────────────

/**
 * Validate the JWT from the incoming BFF request.
 * Returns the validated payload and user profile, or throws UnauthorizedError.
 */
export async function requireAuth(
  headers: Record<string, string | string[] | undefined>,
): Promise<{ payload: JWTPayload; user: UserProfile }> {
  const token = extractToken(headers);

  if (!token) {
    logger.warn('auth_failed', { action: 'auth_failed', reason: 'no_token' });
    throw new UnauthorizedError('No authentication token provided');
  }

  try {
    const { payload } = await validateJwt(token);
    const user = buildUserProfileFromPayload(payload);
    return { payload, user };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    logger.warn('auth_failed', { action: 'auth_failed', reason: 'invalid_token' });
    throw new UnauthorizedError();
  }
}

/**
 * Extract session ID from cookies/headers (does not validate the session).
 */
export function extractSessionId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const cookieHeader = headers['cookie'];
  const cookieStr = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (!cookieStr) return null;

  const cookies = parseCookies(cookieStr);
  return cookies[SESSION_ID_COOKIE] ?? null;
}

/**
 * Build Set-Cookie headers for auth tokens.
 * Secure, HttpOnly, SameSite=Strict cookies prevent XSS/CSRF attacks (OWASP A05, A01).
 */
export function buildAuthCookies(
  accessToken: string,
  refreshToken: string,
  sessionId: string,
  accessExpiresInSeconds: number,
  refreshExpiresInSeconds: number,
): string[] {
  const secure = !env.isDevelopment ? '; Secure' : '';
  const sameSite = 'Strict';

  return [
    `${ACCESS_TOKEN_COOKIE}=${accessToken}; HttpOnly; SameSite=${sameSite}${secure}; Path=/; Max-Age=${accessExpiresInSeconds}`,
    `${REFRESH_TOKEN_COOKIE}=${refreshToken}; HttpOnly; SameSite=${sameSite}${secure}; Path=/bff-api/auth/refresh; Max-Age=${refreshExpiresInSeconds}`,
    `${SESSION_ID_COOKIE}=${sessionId}; HttpOnly; SameSite=${sameSite}${secure}; Path=/; Max-Age=${refreshExpiresInSeconds}`,
  ];
}

/**
 * Build Set-Cookie headers to clear all auth cookies (logout).
 */
export function buildClearAuthCookies(): string[] {
  return [
    `${ACCESS_TOKEN_COOKIE}=; HttpOnly; Path=/; Max-Age=0`,
    `${REFRESH_TOKEN_COOKIE}=; HttpOnly; Path=/bff-api/auth/refresh; Max-Age=0`,
    `${SESSION_ID_COOKIE}=; HttpOnly; Path=/; Max-Age=0`,
  ];
}
