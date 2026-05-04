/**
 * Role checker utility (T-088)
 * Client-side role validation for React components and hooks.
 */

import type { UserProfile } from '@/types/auth';

export type AppRole = 'mc-user' | 'mc-admin';

/**
 * Returns true if the user has the given role.
 * mc-admin implicitly has mc-user access.
 */
export function hasRole(user: UserProfile | null | undefined, role: AppRole): boolean {
  if (!user) return false;
  if (user.roles.includes('mc-admin')) return true;
  return user.roles.includes(role);
}

/** Returns true if user is mc-admin */
export function isAdmin(user: UserProfile | null | undefined): boolean {
  return !!user?.roles.includes('mc-admin');
}

/** Returns true if user has at least mc-user access */
export function isMcUser(user: UserProfile | null | undefined): boolean {
  return hasRole(user, 'mc-user');
}

/** Returns all roles the user has */
export function getUserRoles(user: UserProfile | null | undefined): AppRole[] {
  if (!user) return [];
  return user.roles.filter((r): r is AppRole =>
    r === 'mc-user' || r === 'mc-admin',
  );
}
