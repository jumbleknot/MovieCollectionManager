/**
 * Unit tests for BFF /refresh endpoint (T-073)
 */

jest.mock('@/bff-server/rate-limiter', () => ({
  checkRefreshRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/session-manager', () => ({
  getValidSession: jest.fn().mockResolvedValue({ userId: 'user-1' }),
  touchSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/auth', () => ({
  extractSessionId: jest.fn().mockReturnValue('session-abc'),
  buildAuthCookies: jest.fn().mockReturnValue(['mcm_access_token=new-tok']),
}));

jest.mock('@/bff-server/keycloak', () => ({
  refreshTokens: jest.fn(),
}));

import { POST } from '@/app/bff-api/auth/refresh+api';
import { checkRefreshRateLimit } from '@/bff-server/rate-limiter';
import { getValidSession } from '@/bff-server/session-manager';
import { extractSessionId } from '@/bff-server/auth';
import { refreshTokens } from '@/bff-server/keycloak';
import { AuthErrorCode, RateLimitError } from '@/types/errors';

function makeRequest(cookieHeader = 'mcm_refresh_token=refresh-tok'): Parameters<typeof POST>[0] {
  return {
    url: 'http://localhost/bff-api/auth/refresh',
    headers: new Headers({ cookie: cookieHeader }),
    json: () => Promise.resolve({}),
  } as unknown as Parameters<typeof POST>[0];
}

describe('POST /bff-api/auth/refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (refreshTokens as jest.Mock).mockResolvedValue({
      access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 900,
    });
  });

  it('returns 200 with new cookies on success', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('returns 401 when no session id', async () => {
    (extractSessionId as jest.Mock).mockReturnValueOnce(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.SESSION_NOT_FOUND);
  });

  it('returns 401 when session expired', async () => {
    (getValidSession as jest.Mock).mockResolvedValueOnce(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.SESSION_EXPIRED);
  });

  it('returns 401 when refresh token cookie missing', async () => {
    const res = await POST(makeRequest(''));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.REFRESH_TOKEN_INVALID);
  });

  it('returns 429 on rate limit exceeded', async () => {
    (checkRefreshRateLimit as jest.Mock).mockRejectedValueOnce(new RateLimitError(30));
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
  });
});
