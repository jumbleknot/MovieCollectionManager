/**
 * BFF /user endpoint (T-067)
 * Returns the authenticated user's profile.
 * Checks Redis cache first; falls back to Keycloak Admin API.
 */

import { requireAuth } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { getCachedUserProfile, cacheUserProfile } from '@/bff-server/cache-service';
import { getUserById } from '@/bff-server/keycloak';
import { extractRoles } from '@/bff-server/token-service';
import { validateSessionTimeout } from '@/bff-server/session-timeout';
import { extractSessionId } from '@/bff-server/auth';
import { AuthErrorCode, AuthError } from '@/types/errors';
import { env } from '@/config/env';

export async function GET(req: Request): Promise<Response> {
  try {
    const sessionId = extractSessionId(req.headers);
    if (sessionId) {
      await validateSessionTimeout(sessionId);
    }

    const { payload } = await requireAuth(req.headers);
    const roles = extractRoles(payload, env.keycloakClientId);
    requireMcUser({ id: payload.sub, roles });

    const userId: string = payload.sub;

    // Cache hit
    const cached = await getCachedUserProfile(userId);
    if (cached) {
      return Response.json(cached, { status: 200 });
    }

    // Cache miss — fetch from Keycloak
    const keycloakUser = await getUserById(userId);
    const profile = {
      id: userId,
      username: keycloakUser.username,
      email: keycloakUser.email,
      firstName: keycloakUser.firstName,
      lastName: keycloakUser.lastName,
      roles,
      emailVerified: keycloakUser.emailVerified,
    };

    await cacheUserProfile(profile);

    return Response.json(profile, { status: 200 });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    console.error('[BFF /user]', err);
    return Response.json(
      { error: 'Failed to retrieve user profile.', code: AuthErrorCode.UNKNOWN_ERROR },
      { status: 500 },
    );
  }
}
