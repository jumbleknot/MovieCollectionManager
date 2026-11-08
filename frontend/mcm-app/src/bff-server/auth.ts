/**
 * The BFF's authenticator (T-025; session-only with server-held tokens since feature 085).
 *
 * A request authenticates through ONE credential: the `mcm_session_id` cookie. The member's access
 * and refresh tokens never leave the server — they are sealed beside the session (see
 * session-tokens.ts) — so there is no token for a client to send, and none is read from a request.
 *
 * FR-008/FR-009 (operator decision 2026-11-01): a bearer credential presented to the BFF is NOT
 * honoured in ANY environment, development and test included, and there is no flag that restores
 * it. It was consulted before the cookie, contrary to the ratified client auth model (constitution
 * v2.0.0), and it was exactly the "parallel authentication path created for testing" the
 * constitution prohibits. Test harnesses sign in the way members do
 * (tests/integration/helpers/bff-session.ts). Recorded in openwiki/invariants/auth-chain.md.
 */

import { env } from '@/config/env';
import { validateJwt, extractRoles } from '@/bff-server/token-service';
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
import { logger } from '@/bff-server/logger';
import type { JWTPayload, Session, UserProfile } from '@/types/auth';
import { AuthError, AuthErrorCode } from '@/types/errors';

// ─── Cookie name constants ─────────────────────────────────────────────────────

export const SESSION_ID_COOKIE = 'mcm_session_id';

// The token cookies clients held before feature 085. Kept ONLY so `buildClearAuthCookies` can
// expire them at their original Paths (FR-022); nothing reads them. They can go one absolute
// session lifetime (24 h) after the 085 rollout — tracked as a backlog follow-up.
const RETIRED_ACCESS_TOKEN_COOKIE = 'mcm_access_token';
const RETIRED_REFRESH_TOKEN_COOKIE = 'mcm_refresh_token';
const RETIRED_REFRESH_TOKEN_PATH = '/bff-api/auth/refresh';

export function parseCookies(cookieStr: string): Record<string, string> {
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

export interface AuthenticatedCaller {
  payload: JWTPayload;
  user: UserProfile;
  /** The member's server-held access token, for calls made AS them (mc-service, token exchange). */
  accessToken: string;
  session: Session;
}

/** A session-ending refusal: 401, and the response clears the auth cookies. */
function sessionEnded(code: AuthErrorCode, message: string): AuthError {
  return new AuthError(code, message, 401, { clearCookies: buildClearAuthCookies() });
}

/**
 * Authenticate the request through its session cookie, on every request:
 *   1. the session must exist and be within its absolute, then idle, limit (FR-012, FR-023);
 *   2. its server-held tokens must open for THIS session and owner, and are renewed if due;
 *   3. the access token is validated (signature, iss, aud, azp, exp, nbf) and must belong to the
 *      session's owner;
 *   4. the idle window slides.
 * Throws AuthError: 401 (with cookie clearing) when the member must sign in again, or a retryable
 * 503 when the identity provider is unreachable during a renewal (FR-019).
 */
export async function requireAuth(
  headers: Record<string, string | string[] | undefined>,
): Promise<AuthenticatedCaller> {
  const sessionId = extractSessionId(headers);
  if (!sessionId) {
    // UNAUTHORIZED, as before 085: a request carrying no session reference is unauthenticated —
    // whatever else it carries (a bearer, or a retired token cookie) is not read.
    logger.warn('auth_failed', { action: 'auth_failed', reason: 'no_session' });
    throw sessionEnded(AuthErrorCode.UNAUTHORIZED, 'Authentication required.');
  }

  const live = await readLiveSessionWithTokens(sessionId);
  if ('expired' in live) {
    if (live.expired === 'missing') {
      throw sessionEnded(
        AuthErrorCode.SESSION_NOT_FOUND,
        'Your session could not be found. Please log in again.',
      );
    }
    logger.audit('session_expired', { userId: live.userId, reason: live.expired });
    throw live.expired === 'absolute'
      ? sessionEnded(
          AuthErrorCode.SESSION_ABSOLUTE_TIMEOUT,
          'Your session has ended for security purposes. Please log in again.',
        )
      : sessionEnded(
          AuthErrorCode.SESSION_IDLE_TIMEOUT,
          'Your session has ended due to inactivity. Please log in again.',
        );
  }

  const { session, tokensRaw } = live;
  let tokens: SessionTokens;
  try {
    if (!tokensRaw) throw new Error('session holds no tokens');
    tokens = openSessionTokens(session, tokensRaw);
  } catch {
    // A session created before 085 (no tokens key), or a record that does not open for this
    // session and owner. Neither is trusted, and neither is migrated (FR-022).
    await terminateSession(session.sessionId, session.userId).catch(() => {});
    throw sessionEnded(
      AuthErrorCode.SESSION_NOT_FOUND,
      'Your session could not be found. Please log in again.',
    );
  }

  try {
    tokens = await ensureFreshTokens(session, tokens);
  } catch (err) {
    if (err instanceof AuthError && err.statusCode === 401) {
      throw new AuthError(err.code, err.message, 401, { clearCookies: buildClearAuthCookies() });
    }
    throw err;
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await validateJwt(tokens.accessToken));
  } catch (err) {
    logger.warn('auth_failed', { action: 'auth_failed', reason: 'invalid_token' });
    if (err instanceof AuthError) throw err;
    throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'Authentication required.', 401);
  }

  if (payload.sub !== session.userId) {
    await terminateSession(session.sessionId, session.userId).catch(() => {});
    logger.audit('session_refresh_owner_mismatch', { userId: session.userId });
    throw sessionEnded(
      AuthErrorCode.SESSION_OWNER_MISMATCH,
      'Your session could not be renewed. Please log in again.',
    );
  }

  await touchSession(session);
  return {
    payload,
    user: buildUserProfileFromPayload(payload),
    accessToken: tokens.accessToken,
    session,
  };
}

/**
 * Extract the session ID from the `mcm_session_id` COOKIE — never a header (does not validate the
 * session).
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
 * The ONE cookie the client holds: the opaque session reference (FR-016). Secure outside
 * development, HttpOnly and SameSite=Strict (OWASP A05, A01). It lives as long as the session can;
 * the server ends it sooner on logout, idle or a rejected renewal.
 */
export function buildAuthCookies(sessionId: string): string[] {
  const secure = !env.isDevelopment ? '; Secure' : '';
  const maxAge = Math.floor(env.sessionAbsoluteTimeoutMs / 1000);
  return [
    `${SESSION_ID_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict${secure}; Path=/; Max-Age=${maxAge}`,
  ];
}

/**
 * Clear the session cookie and the two retired token cookies (FR-022). SameSite, Secure and Path
 * must match the originals or the browser ignores the clear — the retired refresh-token cookie was
 * scoped to its own Path. One Set-Cookie line per cookie: comma-joined, the browser keeps all but
 * the first.
 */
export function buildClearAuthCookies(): string[] {
  const secure = !env.isDevelopment ? '; Secure' : '';
  return [
    `${SESSION_ID_COOKIE}=; HttpOnly; SameSite=Strict${secure}; Path=/; Max-Age=0`,
    `${RETIRED_ACCESS_TOKEN_COOKIE}=; HttpOnly; SameSite=Strict${secure}; Path=/; Max-Age=0`,
    `${RETIRED_REFRESH_TOKEN_COOKIE}=; HttpOnly; SameSite=Strict${secure}; Path=${RETIRED_REFRESH_TOKEN_PATH}; Max-Age=0`,
  ];
}
