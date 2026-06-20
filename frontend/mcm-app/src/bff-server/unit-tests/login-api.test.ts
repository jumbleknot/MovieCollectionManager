/**
 * Unit tests for BFF /login endpoint (T-065)
 *
 * Tests the POST handler in isolation by mocking all external dependencies.
 * This verifies that the endpoint correctly orchestrates the login flow,
 * returns the right HTTP responses, and handles error cases gracefully —
 * including cases where external services (Redis, Keycloak Admin) fail.
 */

import { AuthErrorCode, AuthError } from '@/types/errors';

// Import after mocks are registered
import { POST } from '@/app/bff-api/auth/login+api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockExchangeCodeForTokens = jest.fn();
const mockGetUserById = jest.fn();
const mockDecodeJwtPayload = jest.fn();

jest.mock('@/bff-server/keycloak', () => ({
  exchangeCodeForTokens: (...args: unknown[]) => mockExchangeCodeForTokens(...args),
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
  decodeJwtPayload: (...args: unknown[]) => mockDecodeJwtPayload(...args),
}));

const mockValidateJwt = jest.fn();
const mockExtractRoles = jest.fn();
const mockValidateAtHash = jest.fn();

jest.mock('@/bff-server/token-service', () => ({
  validateJwt: (...args: unknown[]) => mockValidateJwt(...args),
  extractRoles: (...args: unknown[]) => mockExtractRoles(...args),
  validateAtHash: (...args: unknown[]) => mockValidateAtHash(...args),
}));

const mockCheckLoginRateLimit = jest.fn();
const mockExtractClientIp = jest.fn();

jest.mock('@/bff-server/rate-limiter', () => ({
  checkLoginRateLimit: (...args: unknown[]) => mockCheckLoginRateLimit(...args),
  extractClientIp: (...args: unknown[]) => mockExtractClientIp(...args),
}));

const mockCreateSession = jest.fn();
const mockGetActiveSessionCount = jest.fn();

jest.mock('@/bff-server/session-manager', () => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  getActiveSessionCount: (...args: unknown[]) => mockGetActiveSessionCount(...args),
}));

const mockBuildAuthCookies = jest.fn();

jest.mock('@/bff-server/auth', () => ({
  buildAuthCookies: (...args: unknown[]) => mockBuildAuthCookies(...args),
}));

jest.mock('@/config/env', () => ({
  env: {
    keycloakClientId: 'movie-collection-manager',
    maxConcurrentSessions: 10,
    sessionAbsoluteTimeoutMs: 86_400_000,
    sessionIdleTimeoutMs: 1_800_000,
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return {
    json: () => Promise.resolve(body),
    headers: {
      get: (key: string) => headers[key.toLowerCase()] ?? null,
      entries: () => Object.entries(headers)[Symbol.iterator](),
    },
  } as unknown as Request;
}

const NOW = Math.floor(Date.now() / 1000);

const VALID_TOKENS = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  id_token: 'id-token',
  expires_in: 900,
  refresh_expires_in: 604800,
};

const VALID_ID_PAYLOAD = {
  sub: 'user-123',
  exp: NOW + 900,
  iat: NOW,
  at_hash: 'valid-at-hash',
};

const VALID_ACCESS_PAYLOAD = {
  sub: 'user-123',
  exp: NOW + 900,
  iat: NOW,
  iss: 'http://localhost:8099/realms/grumpyrobot',
  aud: ['account'],
  azp: 'movie-collection-manager',
};

const VALID_USER = {
  id: 'user-123',
  username: 'testuser',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  enabled: true,
  emailVerified: true,
};

const VALID_SESSION = {
  sessionId: 'sess-abc',
  userId: 'user-123',
  createdAt: Date.now(),
  lastActivityAt: Date.now(),
  expiresAt: Date.now() + 86_400_000,
};

function setupHappyPath() {
  mockExtractClientIp.mockReturnValue('127.0.0.1');
  mockCheckLoginRateLimit.mockResolvedValue(undefined);
  mockExchangeCodeForTokens.mockResolvedValue(VALID_TOKENS);
  mockDecodeJwtPayload.mockReturnValue(VALID_ID_PAYLOAD);
  mockValidateAtHash.mockReturnValue(true);
  mockValidateJwt.mockResolvedValue({ payload: VALID_ACCESS_PAYLOAD, header: { alg: 'RS256', kid: 'key-1', typ: 'JWT' } });
  mockExtractRoles.mockReturnValue(['mc-user']);
  mockGetUserById.mockResolvedValue(VALID_USER);
  mockGetActiveSessionCount.mockResolvedValue(0);
  mockCreateSession.mockResolvedValue(VALID_SESSION);
  mockBuildAuthCookies.mockReturnValue([
    'mcm_access_token=access-token; HttpOnly; Path=/',
    'mcm_refresh_token=refresh-token; HttpOnly; Path=/',
    'mcm_session_id=sess-abc; HttpOnly; Path=/',
  ]);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('POST /bff-api/auth/login', () => {
  it('returns 200 with user profile and sets session ID header on success', async () => {
    setupHappyPath();
    const req = makeRequest({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:8081/auth-callback',
    });

    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; user: { id: string } };
    expect(body.success).toBe(true);
    expect(body.user.id).toBe('user-123');
    expect(res.headers.get('X-Session-Id')).toBe('sess-abc');
  });

  it('sets separate Set-Cookie headers for each auth cookie', async () => {
    setupHappyPath();
    const req = makeRequest({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:8081/auth-callback',
    });

    const res = await POST(req);

    const cookies = res.headers.getSetCookie?.() ?? [];
    expect(cookies.length).toBe(3);
  });

  // ─── Input validation ────────────────────────────────────────────────────────

  it('returns 400 when required fields are missing', async () => {
    setupHappyPath();
    const req = makeRequest({ code: 'auth-code' }); // missing codeVerifier and redirectUri

    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe(AuthErrorCode.INVALID_INPUT);
  });

  // ─── Token validation failures ───────────────────────────────────────────────

  it('returns 401 when JWT audience/azp validation fails', async () => {
    setupHappyPath();
    mockValidateJwt.mockRejectedValue(new AuthError(AuthErrorCode.UNAUTHORIZED, 'Invalid token audience', 401));

    const req = makeRequest({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:8081/auth-callback',
    });

    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json() as { code: string };
    expect(body.code).toBe(AuthErrorCode.UNAUTHORIZED);
  });

  it('returns 401 when at_hash validation fails', async () => {
    setupHappyPath();
    mockValidateAtHash.mockReturnValue(false);

    const req = makeRequest({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:8081/auth-callback',
    });

    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json() as { code: string };
    expect(body.code).toBe(AuthErrorCode.TOKEN_INVALID);
  });

  // ─── Authorization failures ──────────────────────────────────────────────────

  it('returns 403 when user lacks mc-user and mc-admin roles', async () => {
    setupHappyPath();
    mockExtractRoles.mockReturnValue([]);

    const req = makeRequest({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:8081/auth-callback',
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe(AuthErrorCode.FORBIDDEN);
  });

  it('returns 403 when user account is disabled', async () => {
    setupHappyPath();
    mockGetUserById.mockResolvedValue({ ...VALID_USER, enabled: false });

    const req = makeRequest({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:8081/auth-callback',
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe(AuthErrorCode.ACCOUNT_DISABLED);
  });

  // ─── Infrastructure failure handling ─────────────────────────────────────────

  it('returns a structured error (not 500 UNKNOWN_ERROR) when Redis session creation fails', async () => {
    setupHappyPath();
    mockCreateSession.mockRejectedValue(new Error('ECONNREFUSED connect ECONNREFUSED 127.0.0.1:6379'));

    const req = makeRequest({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:8081/auth-callback',
    });

    const res = await POST(req);

    // Must NOT be 500 with UNKNOWN_ERROR — infrastructure errors must be handled
    expect(res.status).not.toBe(500);
    const body = await res.json() as { code: string };
    expect(body.code).not.toBe(AuthErrorCode.UNKNOWN_ERROR);
  });

  it('returns 503 when Keycloak Admin API is unreachable during getUserById', async () => {
    setupHappyPath();
    mockGetUserById.mockRejectedValue(new TypeError('fetch failed'));

    const req = makeRequest({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:8081/auth-callback',
    });

    const res = await POST(req);

    expect(res.status).toBe(503);
    const body = await res.json() as { code: string };
    expect(body.code).toBe(AuthErrorCode.KEYCLOAK_UNAVAILABLE);
  });
});
