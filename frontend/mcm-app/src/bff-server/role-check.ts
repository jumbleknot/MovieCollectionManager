/**
 * Role-based access control middleware (T-026)
 * Verifies that the authenticated user has one of the required client roles.
 * Applied after requireAuth() in BFF route handlers.
 */

import type { UserProfile } from '@/types/auth';
import { ClientRole } from '@/types/auth';
import { ForbiddenError } from '@/types/errors';
import { logger } from '@/bff-server/logger';

// ─── RBAC check ────────────────────────────────────────────────────────────────

/**
 * Verify the user has at least one of the required roles.
 * Throws ForbiddenError (403) if none match.
 */
export function requireRole(user: UserProfile, ...roles: ClientRole[]): void {
  const hasRole = roles.some((role) => user.roles.includes(role));
  if (!hasRole) {
    logger.warn('access_denied', { action: 'access_denied', userId: user.id, required: roles, actual: user.roles });
    throw new ForbiddenError();
  }
}

/**
 * Verify the user has the mc-user role (standard access).
 */
export function requireMcUser(user: UserProfile): void {
  requireRole(user, ClientRole.MCUser, ClientRole.MCAdmin); // mc-admin implicitly has mc-user access
}

/**
 * Verify the user has the mc-admin role (admin-only access).
 */
export function requireMcAdmin(user: UserProfile): void {
  requireRole(user, ClientRole.MCAdmin);
}

/**
 * Check (without throwing) whether a user has a given role.
 */
export function hasRole(user: UserProfile, role: ClientRole): boolean {
  return user.roles.includes(role);
}

/**
 * Check whether the user is an admin.
 */
export function isAdmin(user: UserProfile): boolean {
  return hasRole(user, ClientRole.MCAdmin);
}
