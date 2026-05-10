/**
 * Unit tests for BFF /user endpoint (T-074)
 */

jest.mock('@/bff-server/auth', () => ({
  requireAuth: jest.fn(),
  extractSessionId: jest.fn().mockReturnValue(null),
}));

jest.mock('@/bff-server/role-check', () => ({
  requireMcUser: jest.fn(),
}));

jest.mock('@/bff-server/cache-service', () => ({
  getCachedUserProfile: jest.fn().mockResolvedValue(null),
  cacheUserProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/keycloak', () => ({
  getUserById: jest.fn(),
}));

jest.mock('@/bff-server/token-service', () => ({
  extractRoles: jest.fn().mockReturnValue(['mc-user']),
}));

jest.mock('@/bff-server/session-timeout', () => ({
  validateSessionTimeout: jest.fn().mockResolvedValue(undefined),
}));

import { GET } from '@/app/bff-api/auth/user+api';
import { requireAuth } from '@/bff-server/auth';
import { getCachedUserProfile } from '@/bff-server/cache-service';
import { getUserById } from '@/bff-server/keycloak';
import { requireMcUser } from '@/bff-server/role-check';
import { AuthErrorCode, AuthError, UnauthorizedError } from '@/types/errors';

function makeRequest(): Parameters<typeof GET>[0] {
  return {
    url: 'http://localhost/bff-api/auth/user',
    headers: new Headers({ authorization: 'Bearer access-tok' }),
    json: () => Promise.resolve({}),
  } as unknown as Parameters<typeof GET>[0];
}

const mockPayload = { sub: 'user-1', exp: 99999999999 };
const mockUserProfile = {
  id: 'user-1', username: 'tuser', email: 'test@example.com',
  firstName: 'Test', lastName: 'User', emailVerified: true,
  roles: ['mc-user'], accountStatus: 'active' as const, createdAt: '2026-01-01T00:00:00.000Z',
};
const mockProfile = {
  id: 'user-1', username: 'tuser', email: 'test@example.com',
  firstName: 'Test', lastName: 'User', emailVerified: true, enabled: true,
  createdTimestamp: 1735689600000,
};

describe('GET /bff-api/auth/user', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: mockPayload, user: mockUserProfile });
    (getUserById as jest.Mock).mockResolvedValue(mockProfile);
  });

  it('returns 200 with user profile on cache miss (fetches from Keycloak)', async () => {
    (getCachedUserProfile as jest.Mock).mockResolvedValueOnce(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.username).toBe('tuser');
  });

  it('returns 200 with cached profile on cache hit', async () => {
    (getCachedUserProfile as jest.Mock).mockResolvedValueOnce({ ...mockProfile, cached: true });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cached).toBe(true);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('returns 401 when auth fails', async () => {
    (requireAuth as jest.Mock).mockRejectedValueOnce(new UnauthorizedError());
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.UNAUTHORIZED);
  });

  it('returns 403 when role check fails', async () => {
    (requireMcUser as jest.Mock).mockImplementationOnce(() => {
      throw new AuthError(AuthErrorCode.FORBIDDEN, 'Forbidden', 403);
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });
});
