/**
 * Unit tests for RBAC middleware (T-153)
 *
 * Covers:
 *   - Valid mc-user role → access granted
 *   - Valid mc-admin role → access granted (mc-admin has mc-user access)
 *   - Unauthenticated / no roles → rejected (401/403)
 *   - Authenticated user with no matching role → rejected (403)
 *   - Missing role claim in JWT (empty roles array) → rejected (403)
 */

import {
  requireRole,
  requireMcUser,
  requireMcAdmin,
  hasRole,
  isAdmin,
} from '@/bff-server/role-check';
import { ClientRole } from '@/types/auth';
import { ForbiddenError } from '@/types/errors';
import type { UserProfile } from '@/types/auth';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(roles: string[]): UserProfile {
  return {
    id: 'user-123',
    username: 'testuser',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    roles,
    emailVerified: true,
    accountStatus: 'active',
    createdAt: new Date().toISOString(),
  };
}

// ─── requireMcUser ────────────────────────────────────────────────────────────

describe('requireMcUser', () => {
  it('grants access to user with mc-user role', () => {
    expect(() => requireMcUser(makeUser([ClientRole.MCUser]))).not.toThrow();
  });

  it('grants access to user with mc-admin role (mc-admin implicitly has mc-user access)', () => {
    expect(() => requireMcUser(makeUser([ClientRole.MCAdmin]))).not.toThrow();
  });

  it('rejects authenticated user with no matching role with ForbiddenError (403)', () => {
    expect(() => requireMcUser(makeUser(['some-other-role']))).toThrow(ForbiddenError);
  });

  it('rejects user with missing role claim in JWT (empty roles array) with 403', () => {
    expect(() => requireMcUser(makeUser([]))).toThrow(ForbiddenError);

    try {
      requireMcUser(makeUser([]));
    } catch (err) {
      expect((err as ForbiddenError).statusCode).toBe(403);
    }
  });
});

// ─── requireMcAdmin ───────────────────────────────────────────────────────────

describe('requireMcAdmin', () => {
  it('grants access to user with mc-admin role', () => {
    expect(() => requireMcAdmin(makeUser([ClientRole.MCAdmin]))).not.toThrow();
  });

  it('rejects user with only mc-user role (403)', () => {
    expect(() => requireMcAdmin(makeUser([ClientRole.MCUser]))).toThrow(ForbiddenError);
  });

  it('rejects user with no roles (403)', () => {
    expect(() => requireMcAdmin(makeUser([]))).toThrow(ForbiddenError);
  });
});

// ─── requireRole ─────────────────────────────────────────────────────────────

describe('requireRole', () => {
  it('passes when user has the required role', () => {
    expect(() => requireRole(makeUser([ClientRole.MCUser]), ClientRole.MCUser)).not.toThrow();
  });

  it('passes when user has one of multiple accepted roles', () => {
    expect(() =>
      requireRole(makeUser([ClientRole.MCUser]), ClientRole.MCUser, ClientRole.MCAdmin),
    ).not.toThrow();
  });

  it('throws ForbiddenError (403) when user has no matching role', () => {
    expect(() => requireRole(makeUser([ClientRole.MCUser]), ClientRole.MCAdmin)).toThrow(
      ForbiddenError,
    );
  });

  it('ForbiddenError statusCode is 403', () => {
    let caughtError: unknown;
    try {
      requireRole(makeUser([]), ClientRole.MCUser);
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(ForbiddenError);
    expect((caughtError as ForbiddenError).statusCode).toBe(403);
  });

  it('rejects unauthenticated request (missing role claim) with 403', () => {
    // When the JWT has no role claim, extracted roles will be empty
    expect(() =>
      requireRole(makeUser([]), ClientRole.MCUser, ClientRole.MCAdmin),
    ).toThrow(ForbiddenError);
  });
});

// ─── hasRole ──────────────────────────────────────────────────────────────────

describe('hasRole', () => {
  it('returns true when user has the specified role', () => {
    expect(hasRole(makeUser([ClientRole.MCUser]), ClientRole.MCUser)).toBe(true);
  });

  it('returns false when user does not have the specified role', () => {
    expect(hasRole(makeUser([ClientRole.MCUser]), ClientRole.MCAdmin)).toBe(false);
  });

  it('returns false when roles array is empty', () => {
    expect(hasRole(makeUser([]), ClientRole.MCUser)).toBe(false);
  });
});

// ─── isAdmin ──────────────────────────────────────────────────────────────────

describe('isAdmin', () => {
  it('returns true for a user with mc-admin role', () => {
    expect(isAdmin(makeUser([ClientRole.MCAdmin]))).toBe(true);
  });

  it('returns false for a user with only mc-user role', () => {
    expect(isAdmin(makeUser([ClientRole.MCUser]))).toBe(false);
  });

  it('returns false for a user with no roles', () => {
    expect(isAdmin(makeUser([]))).toBe(false);
  });
});
