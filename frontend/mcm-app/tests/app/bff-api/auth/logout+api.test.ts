/**
 * Unit tests for BFF /logout endpoint (T-109)
 */

jest.mock('@/bff-server/auth', () => ({
  requireAuth: jest.fn().mockResolvedValue({}),
  extractSessionId: jest.fn().mockReturnValue('session-abc'),
  buildClearAuthCookies: jest.fn().mockReturnValue(['mcm_access_token=; Max-Age=0']),
}));

jest.mock('@/bff-server/keycloak', () => ({
  revokeToken: jest.fn().mockResolvedValue(undefined),
  logoutUserSessions: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/session-manager', () => ({
  terminateSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/cache-service', () => ({
  getSession: jest.fn().mockResolvedValue({
    sessionId: 'session-abc',
    userId: 'user-1',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 86400000,
  }),
}));

import { POST } from '@/app/bff-api/auth/logout+api';
import { terminateSession } from '@/bff-server/session-manager';
import { revokeToken } from '@/bff-server/keycloak';

function makeRequest(cookie = 'mcm_refresh_token=refresh-tok'): Parameters<typeof POST>[0] {
  return {
    url: 'http://localhost/bff-api/auth/logout',
    headers: new Headers({ cookie }),
    json: () => Promise.resolve({}),
  } as unknown as Parameters<typeof POST>[0];
}

describe('POST /bff-api/auth/logout', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 on successful logout', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('terminates the current session in Redis', async () => {
    await POST(makeRequest());
    expect(terminateSession).toHaveBeenCalledWith('session-abc', 'user-1');
  });

  it('revokes refresh token in Keycloak', async () => {
    await POST(makeRequest());
    expect(revokeToken).toHaveBeenCalledWith('refresh-tok', 'refresh_token');
  });

  it('still returns 200 when no refresh token cookie is present', async () => {
    const res = await POST(makeRequest(''));
    expect(res.status).toBe(200);
    // revoke should not be called if no refresh token
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it('does NOT terminate other sessions', async () => {
    await POST(makeRequest());
    // terminateSession should be called exactly once (for current session only)
    expect(terminateSession).toHaveBeenCalledTimes(1);
  });
});
