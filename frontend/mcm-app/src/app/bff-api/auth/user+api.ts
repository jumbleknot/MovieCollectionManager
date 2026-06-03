/**
 * BFF /user endpoint (T-067)
 * Returns the authenticated user's profile.
 * Checks Redis cache first; falls back to Keycloak Admin API.
 */

import { requireAuth } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { getCachedUserProfile, cacheUserProfile, getSession } from '@/bff-server/cache-service';
import { getUserById } from '@/bff-server/keycloak';
import { extractRoles } from '@/bff-server/token-service';
import { validateSessionTimeout } from '@/bff-server/session-timeout';
import { extractSessionId } from '@/bff-server/auth';
import { logger } from '@/bff-server/logger';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { AuthErrorCode, AuthError } from '@/types/errors';
import type { UserProfile } from '@/types/auth';
import { env } from '@/config/env';

export async function GET(req: Request): Promise<Response> {
  return withRequestContext(() => _get(req));
}

async function _get(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());

    // Authenticate BEFORE any session side effect (009 finding #9): an
    // unauthenticated caller must never be able to trigger session timeout
    // enforcement on an attacker-supplied X-Session-Id.
    const { payload, user } = await requireAuth(headers);
    requireMcUser(user);

    // Validate/slide the idle window ONLY for the caller's own session — never a
    // session id that does not belong to the authenticated user.
    const sessionId = extractSessionId(headers);
    if (sessionId) {
      const session = await getSession(sessionId).catch(() => null);
      if (session && session.userId === payload.sub) {
        await validateSessionTimeout(sessionId);
      }
    }

    const userId: string = payload.sub;
    const roles = extractRoles(payload, env.keycloakClientId);

    // Cache hit
    const cached = await getCachedUserProfile(userId);
    if (cached) {
      return Response.json(cached, { status: 200, headers: securityHeaders() });
    }

    // Cache miss — fetch from Keycloak
    const keycloakUser = await getUserById(userId);
    const profile: UserProfile = {
      id: userId,
      username: keycloakUser.username,
      email: keycloakUser.email,
      firstName: keycloakUser.firstName,
      lastName: keycloakUser.lastName,
      roles,
      emailVerified: keycloakUser.emailVerified,
      accountStatus: keycloakUser.enabled ? 'active' : 'disabled',
      createdAt: new Date(keycloakUser.createdTimestamp).toISOString(),
    };

    await cacheUserProfile(profile);

    return Response.json(profile, { status: 200, headers: securityHeaders() });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.statusCode, headers: securityHeaders() },
      );
    }
    logger.error('user: unhandled error', { action: 'user_error', error: err });
    return Response.json(
      { error: 'Failed to retrieve user profile.', code: AuthErrorCode.UNKNOWN_ERROR },
      { status: 500, headers: securityHeaders() },
    );
  }
}
