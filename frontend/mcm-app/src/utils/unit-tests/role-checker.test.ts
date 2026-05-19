/**
 * Unit tests for role-checker utility (T-094)
 */

import { hasRole, isAdmin, isMcUser, getUserRoles } from '@/utils/role-checker';
import type { UserProfile } from '@/types/auth';

function makeUser(roles: string[]): UserProfile {
  return {
    id: 'u1', username: 'u', email: 'u@e.com',
    firstName: 'F', lastName: 'L',
    roles: roles as UserProfile['roles'],
    emailVerified: true,
    accountStatus: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('role-checker', () => {
  describe('hasRole', () => {
    it('returns true for mc-user with mc-user role', () => {
      expect(hasRole(makeUser(['mc-user']), 'mc-user')).toBe(true);
    });

    it('returns true for mc-admin when checking mc-user (implicit)', () => {
      expect(hasRole(makeUser(['mc-admin']), 'mc-user')).toBe(true);
    });

    it('returns false for user without required role', () => {
      expect(hasRole(makeUser([]), 'mc-user')).toBe(false);
    });

    it('returns false for null user', () => {
      expect(hasRole(null, 'mc-user')).toBe(false);
    });
  });

  describe('isAdmin', () => {
    it('returns true for mc-admin', () => {
      expect(isAdmin(makeUser(['mc-admin']))).toBe(true);
    });

    it('returns false for mc-user', () => {
      expect(isAdmin(makeUser(['mc-user']))).toBe(false);
    });
  });

  describe('isMcUser', () => {
    it('returns true for mc-user', () => {
      expect(isMcUser(makeUser(['mc-user']))).toBe(true);
    });

    it('returns true for mc-admin (implicit)', () => {
      expect(isMcUser(makeUser(['mc-admin']))).toBe(true);
    });

    it('returns false for no roles', () => {
      expect(isMcUser(makeUser([]))).toBe(false);
    });
  });

  describe('getUserRoles', () => {
    it('returns known roles only', () => {
      expect(getUserRoles(makeUser(['mc-user', 'mc-admin', 'other']))).toEqual(['mc-user', 'mc-admin']);
    });

    it('returns empty array for null user', () => {
      expect(getUserRoles(null)).toEqual([]);
    });
  });
});
