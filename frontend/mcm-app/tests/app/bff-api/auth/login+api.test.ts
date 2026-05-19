/**
 * Unit tests for BFF /login endpoint (T-072)
 */

jest.mock('@/bff-server/rate-limiter', () => ({
  checkLoginRateLimit: jest.fn().mockResolvedValue(undefined),
  extractClientIp: jest.fn().mockReturnValue('127.0.0.1'),
}));

jest.mock('@/bff-server/keycloak', () => ({
  exchangeCodeForTokens: jest.fn(),
  getUserById: jest.fn(),
  decodeJwtPayload: jest.fn(),
}));

jest.mock('@/bff-server/token-service', () => ({
  validateJwt: jest.fn(),
  extractRoles: jest.fn().mockReturnValue(['mc-user']),
  validateAtHash: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/bff-server/session-manager', () => ({
  createSession: jest.fn().mockResolvedValue({
    sessionId: 'session-new',
    userId: 'user-1',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 86400000,
  }),
  getActiveSessionCount: jest.fn().mockResolvedValue(0),
}));

jest.mock('@/bff-server/auth', () => ({
  buildAuthCookies: jest.fn().mockReturnValue(['mcm_access_token=token']),
  extractSessionId: jest.fn().mockReturnValue(null),
}));

import { POST } from '@/app/bff-api/auth/login+api';
import { exchangeCodeForTokens, getUserById, decodeJwtPayload } from '@/bff-server/keycloak';
import { validateJwt, extractRoles } from '@/bff-server/token-service';
import { checkLoginRateLimit } from '@/bff-server/rate-limiter';
import { AuthErrorCode, RateLimitError } from '@/types/errors';

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return {
    url: 'http://localhost/bff-api/auth/login',
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Parameters<typeof POST>[0];
}

const now = Math.floor(Date.now() / 1000);

const mockTokens = {
  access_token: 'access-tok',
  refresh_token: 'refresh-tok',
  id_token: 'id-tok',
  expires_in: 900,
  refresh_expires_in: 604800,
};

const mockIdPayload = { sub: 'user-1', exp: now + 900, iss: 'http://kc' };
const mockAccessPayload = { sub: 'user-1', exp: now + 900 };
const mockKeycloakUser = {
  id: 'user-1', username: 'tuser', email: 'test@example.com',
  firstName: 'Test', lastName: 'User', emailVerified: true, enabled: true,
};

function setupMocks() {
  (exchangeCodeForTokens as jest.Mock).mockResolvedValue(mockTokens);
  (decodeJwtPayload as jest.Mock).mockReturnValue(mockIdPayload);
  (validateJwt as jest.Mock).mockResolvedValue({ payload: mockAccessPayload, header: { alg: 'RS256', kid: 'key1', typ: 'JWT' } });
  (extractRoles as jest.Mock).mockReturnValue(['mc-user']);
  (getUserById as jest.Mock).mockResolvedValue(mockKeycloakUser);
}

describe('POST /bff-api/auth/login', () => {
  beforeEach(() => { jest.clearAllMocks(); setupMocks(); });

  it('returns 200 with user profile for valid code exchange', async () => {
    const res = await POST(makeRequest({
      code: 'auth-code', codeVerifier: 'verifier', redirectUri: 'mcm-app://callback',
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.user.username).toBe('tuser');
  });

  it('returns 400 when required fields missing', async () => {
    const res = await POST(makeRequest({ code: 'auth-code' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.INVALID_INPUT);
  });

  it('returns 429 when rate limit exceeded', async () => {
    (checkLoginRateLimit as jest.Mock).mockRejectedValueOnce(new RateLimitError(60));
    const res = await POST(makeRequest({
      code: 'auth-code', codeVerifier: 'verifier', redirectUri: 'mcm-app://callback',
    }));
    expect(res.status).toBe(429);
  });

  it('returns 403 when user lacks required role', async () => {
    (extractRoles as jest.Mock).mockReturnValueOnce([]);
    const res = await POST(makeRequest({
      code: 'auth-code', codeVerifier: 'verifier', redirectUri: 'mcm-app://callback',
    }));
    expect(res.status).toBe(403);
  });

  it('returns 403 when account is disabled', async () => {
    (getUserById as jest.Mock).mockResolvedValueOnce({ ...mockKeycloakUser, enabled: false });
    const res = await POST(makeRequest({
      code: 'auth-code', codeVerifier: 'verifier', redirectUri: 'mcm-app://callback',
    }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.ACCOUNT_DISABLED);
  });
});
