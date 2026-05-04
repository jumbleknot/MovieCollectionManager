/**
 * Unit tests for token service (T-035)
 * Tests JWT utilities that don't require network calls.
 */

import { isTokenExpired, isTokenExpiringSoon, extractRoles } from '@/bff-server/token-service';
import type { JWTPayload } from '@/types/auth';

function makePayload(overrides: Partial<JWTPayload> = {}): JWTPayload {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub: 'user-123',
    iss: 'http://localhost:8080/realms/jumbleknot',
    aud: 'movie-collection-manager',
    exp: nowSeconds + 900, // 15 min from now
    iat: nowSeconds,
    jti: 'jwt-id-123',
    auth_time: nowSeconds,
    scope: 'openid profile email',
    preferred_username: 'testuser',
    email: 'test@example.com',
    email_verified: true,
    name: 'Test User',
    given_name: 'Test',
    family_name: 'User',
    ...overrides,
  };
}

describe('isTokenExpired', () => {
  it('returns false for unexpired token', () => {
    const payload = makePayload();
    expect(isTokenExpired(payload)).toBe(false);
  });

  it('returns true for expired token', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = makePayload({ exp: nowSeconds - 1 });
    expect(isTokenExpired(payload)).toBe(true);
  });
});

describe('isTokenExpiringSoon', () => {
  it('returns false when token expires well in the future', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = makePayload({ exp: nowSeconds + 500 });
    expect(isTokenExpiringSoon(payload, 60)).toBe(false);
  });

  it('returns true when token is within threshold', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = makePayload({ exp: nowSeconds + 30 });
    expect(isTokenExpiringSoon(payload, 60)).toBe(true);
  });

  it('returns true for already-expired token', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = makePayload({ exp: nowSeconds - 1 });
    expect(isTokenExpiringSoon(payload, 60)).toBe(true);
  });
});

describe('extractRoles', () => {
  it('extracts client roles from resource_access', () => {
    const payload = makePayload({
      resource_access: {
        'movie-collection-manager': { roles: ['mc-user'] },
      },
    });
    expect(extractRoles(payload, 'movie-collection-manager')).toEqual(['mc-user']);
  });

  it('returns empty array when no resource_access', () => {
    const payload = makePayload();
    expect(extractRoles(payload, 'movie-collection-manager')).toEqual([]);
  });

  it('returns empty array when client not in resource_access', () => {
    const payload = makePayload({
      resource_access: {
        'other-client': { roles: ['some-role'] },
      } as JWTPayload['resource_access'],
    });
    expect(extractRoles(payload, 'movie-collection-manager')).toEqual([]);
  });
});
