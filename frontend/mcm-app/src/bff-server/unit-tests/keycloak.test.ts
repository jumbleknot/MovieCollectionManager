/**
 * Unit tests for Keycloak client service (T-034)
 * Tests token exchange, user creation, and error handling.
 */

import { exchangeCodeForTokens, refreshTokens, decodeJwtPayload, getUserIdByEmail, __clearDiscoveryCache } from '@/bff-server/keycloak';
import { AuthErrorCode } from '@/types/errors';

// Mock fetch globally
global.fetch = jest.fn();
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

beforeEach(() => {
  jest.clearAllMocks();
  __clearDiscoveryCache();
});

// ─── Discovery mock helper ─────────────────────────────────────────────────────

function mockDiscovery() {
  return {
    token_endpoint: 'http://localhost:8099/realms/grumpyrobot/protocol/openid-connect/token',
    authorization_endpoint: 'http://localhost:8099/realms/grumpyrobot/protocol/openid-connect/auth',
    userinfo_endpoint: 'http://localhost:8099/realms/grumpyrobot/protocol/openid-connect/userinfo',
    end_session_endpoint: 'http://localhost:8099/realms/grumpyrobot/protocol/openid-connect/logout',
    jwks_uri: 'http://localhost:8099/realms/grumpyrobot/protocol/openid-connect/certs',
  };
}

function makeTokenResponse() {
  return {
    access_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.sig',
    refresh_token: 'refresh-token-value',
    id_token: 'id-token-value',
    token_type: 'Bearer',
    expires_in: 900,
    refresh_expires_in: 604800,
    scope: 'openid profile email',
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

// ─── decodeJwtPayload ─────────────────────────────────────────────────────────

describe('decodeJwtPayload', () => {
  it('decodes a valid JWT payload', () => {
    const payload = { sub: 'user-123', email: 'test@example.com' };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `header.${encoded}.signature`;

    const result = decodeJwtPayload(token);
    expect(result.sub).toBe('user-123');
    expect(result.email).toBe('test@example.com');
  });

  it('throws AUTH_CODE_INVALID for malformed token', () => {
    expect(() => decodeJwtPayload('not.a.valid.jwt.token')).toThrow();
  });
});

// ─── exchangeCodeForTokens ────────────────────────────────────────────────────

describe('exchangeCodeForTokens', () => {
  it('returns token response on success', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(mockDiscovery()))   // discovery
      .mockResolvedValueOnce(jsonResponse(makeTokenResponse())); // token exchange

    const result = await exchangeCodeForTokens(
      'auth-code-abc',
      'verifier-xyz',
      'mcm-app://native-auth-callback',
    );

    expect(result.access_token).toBe('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.sig');
    expect(result.expires_in).toBe(900);
  });

  it('throws AUTH_CODE_INVALID for invalid_grant error', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(mockDiscovery()))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(
      exchangeCodeForTokens('bad-code', 'verifier', 'http://redirect'),
    ).rejects.toMatchObject({ code: AuthErrorCode.AUTH_CODE_INVALID });
  });

  it('throws INVALID_CREDENTIALS for other token endpoint errors', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(mockDiscovery()))
      .mockResolvedValueOnce(jsonResponse({ error: 'server_error' }, 500));

    await expect(
      exchangeCodeForTokens('code', 'verifier', 'http://redirect'),
    ).rejects.toMatchObject({ code: AuthErrorCode.INVALID_CREDENTIALS });
  });
});

// ─── refreshTokens ────────────────────────────────────────────────────────────

describe('refreshTokens', () => {
  it('returns new token response on success', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(mockDiscovery()))
      .mockResolvedValueOnce(jsonResponse(makeTokenResponse()));

    const result = await refreshTokens('old-refresh-token');
    expect(result.access_token).toBeDefined();
  });

  it('throws REFRESH_FAILED on error', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(mockDiscovery()))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_token' }, 401));

    await expect(refreshTokens('bad-refresh-token')).rejects.toMatchObject({
      code: AuthErrorCode.REFRESH_FAILED,
    });
  });

  // Feature 085 (FR-019): the server now renews on the member's behalf, so a REJECTED refresh (the
  // grant is gone — sign in again) must be told apart from an OUTAGE (keep the session, retry).
  it.each([400, 401])('a %i from the token endpoint is a rejection: 401 REFRESH_FAILED', async (status) => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(mockDiscovery()))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, status));
    await expect(refreshTokens('rt')).rejects.toMatchObject({ code: AuthErrorCode.REFRESH_FAILED, statusCode: 401 });
  });

  it.each([500, 502, 503])('a %i is transient: 503 KEYCLOAK_UNAVAILABLE, retryable', async (status) => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(mockDiscovery()))
      .mockResolvedValueOnce(jsonResponse({}, status));
    await expect(refreshTokens('rt')).rejects.toMatchObject({
      code: AuthErrorCode.KEYCLOAK_UNAVAILABLE,
      statusCode: 503,
      retryAfterSeconds: 5,
    });
  });

  it('a network error or timeout is transient, not a sign-out', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(mockDiscovery()))
      .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    await expect(refreshTokens('rt')).rejects.toMatchObject({ code: AuthErrorCode.KEYCLOAK_UNAVAILABLE, statusCode: 503 });
  });

  it('bounds the token call with a timeout signal', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(mockDiscovery()))
      .mockResolvedValueOnce(jsonResponse(makeTokenResponse()));
    await refreshTokens('rt');
    expect((mockedFetch.mock.calls[1][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});

// ─── getUserIdByEmail ─────────────────────────────────────────────────────────

describe('getUserIdByEmail', () => {
  function mockAdminToken() {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'admin-tok' }));
  }

  it('returns userId for an unverified user', async () => {
    mockAdminToken();
    mockedFetch.mockResolvedValueOnce(
      jsonResponse([{ id: 'user-123', email: 'test@example.com', emailVerified: false }]),
    );

    const result = await getUserIdByEmail('test@example.com');
    expect(result).toBe('user-123');
  });

  it('returns null when no users match the email', async () => {
    mockAdminToken();
    mockedFetch.mockResolvedValueOnce(jsonResponse([]));

    const result = await getUserIdByEmail('notfound@example.com');
    expect(result).toBeNull();
  });

  it('returns null when admin API returns non-ok response', async () => {
    mockAdminToken();
    mockedFetch.mockResolvedValueOnce(jsonResponse({}, 500));

    const result = await getUserIdByEmail('test@example.com');
    expect(result).toBeNull();
  });

  it('throws ALREADY_VERIFIED when email is already verified', async () => {
    mockAdminToken();
    mockedFetch.mockResolvedValueOnce(
      jsonResponse([{ id: 'user-123', email: 'test@example.com', emailVerified: true }]),
    );

    await expect(getUserIdByEmail('test@example.com')).rejects.toMatchObject({
      code: AuthErrorCode.ALREADY_VERIFIED,
    });
  });
});
