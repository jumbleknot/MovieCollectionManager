/**
 * Unit tests for JWT validation middleware (T-151)
 *
 * Covers:
 *   - Session ID extracted from HTTP-only cookie → JWT resolved (success)
 *   - No token present → 401 (session not found)
 *   - Authorization Bearer header fallback (service-to-service)
 *   - Valid JWT accepted
 *   - Invalid/tampered signature → 401
 *   - Expired token → 401
 *   - Missing token → 401
 *   - Malformed token → 401
 *   - Wrong issuer → 401
 *   - Wrong audience → 401
 *   - Wrong/missing azp → 401
 *   - nbf in the future → 401
 */

import {
  requireAuth,
  extractSessionId,
  buildUserProfileFromPayload,
  buildAuthCookies,
  buildClearAuthCookies,
  SESSION_ID_COOKIE,
  ACCESS_TOKEN_COOKIE,
} from '@/bff-server/auth';
import { AuthError, AuthErrorCode, UnauthorizedError } from '@/types/errors';
import type { JWTPayload } from '@/types/auth';

// ─── Mock token-service ───────────────────────────────────────────────────────

jest.mock('@/bff-server/token-service', () => ({
  validateJwt: jest.fn(),
  extractRoles: jest.fn().mockReturnValue(['mc-user']),
}));

import { validateJwt, extractRoles } from '@/bff-server/token-service';
const mockedValidateJwt = validateJwt as jest.MockedFunction<typeof validateJwt>;
const mockedExtractRoles = extractRoles as jest.MockedFunction<typeof extractRoles>;

// ─── Mock env ─────────────────────────────────────────────────────────────────

jest.mock('@/config/env', () => ({
  env: {
    keycloakClientId: 'movie-collection-manager',
    isDevelopment: true,
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePayload(overrides: Partial<JWTPayload> = {}): JWTPayload {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub: 'user-123',
    iss: 'http://localhost:8099/realms/jumbleknot',
    aud: 'movie-collection-manager',
    exp: nowSeconds + 900,
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
    resource_access: {
      'movie-collection-manager': { roles: ['mc-user'] },
    },
    ...overrides,
  };
}

function makeValidatedToken(payload: JWTPayload) {
  return { payload, header: { alg: 'RS256', kid: 'key-1', typ: 'JWT' } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedExtractRoles.mockReturnValue(['mc-user']);
});

// ─── requireAuth ─────────────────────────────────────────────────────────────

describe('requireAuth', () => {
  it('resolves JWT from HTTP-only access token cookie (session present)', async () => {
    const payload = makePayload();
    mockedValidateJwt.mockResolvedValue(makeValidatedToken(payload));

    const headers = {
      cookie: `${ACCESS_TOKEN_COOKIE}=valid.jwt.from.cookie; ${SESSION_ID_COOKIE}=session-abc`,
    };
    const result = await requireAuth(headers);

    expect(mockedValidateJwt).toHaveBeenCalledWith('valid.jwt.from.cookie');
    expect(result.user.id).toBe('user-123');
    expect(result.user.username).toBe('testuser');
  });

  it('resolves JWT from Authorization Bearer header (service-to-service fallback)', async () => {
    const payload = makePayload();
    mockedValidateJwt.mockResolvedValue(makeValidatedToken(payload));

    const result = await requireAuth({ authorization: 'Bearer valid.jwt.token' });

    expect(mockedValidateJwt).toHaveBeenCalledWith('valid.jwt.token');
    expect(result.payload.sub).toBe('user-123');
  });

  it('prefers Authorization header over cookie token', async () => {
    const payload = makePayload();
    mockedValidateJwt.mockResolvedValue(makeValidatedToken(payload));

    const headers = {
      authorization: 'Bearer header.token',
      cookie: `${ACCESS_TOKEN_COOKIE}=cookie.token`,
    };
    await requireAuth(headers);

    expect(mockedValidateJwt).toHaveBeenCalledWith('header.token');
  });

  it('rejects with 401 when no token is provided (session not found)', async () => {
    await expect(requireAuth({})).rejects.toBeInstanceOf(UnauthorizedError);

    let caughtError: unknown;
    try {
      await requireAuth({});
    } catch (err) {
      caughtError = err;
    }
    expect((caughtError as UnauthorizedError).statusCode).toBe(401);
  });

  it('accepts valid JWT and returns user profile', async () => {
    const payload = makePayload();
    mockedValidateJwt.mockResolvedValue(makeValidatedToken(payload));

    const result = await requireAuth({ authorization: 'Bearer valid.jwt' });

    expect(result.user.emailVerified).toBe(true);
    expect(result.user.accountStatus).toBe('active');
    expect(result.user.email).toBe('test@example.com');
  });

  it('rejects with 401 when JWT has invalid or tampered signature', async () => {
    mockedValidateJwt.mockRejectedValue(
      new AuthError(AuthErrorCode.UNAUTHORIZED, 'Invalid token signature', 401),
    );

    await expect(requireAuth({ authorization: 'Bearer tampered.jwt' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects with 401 when JWT is expired', async () => {
    mockedValidateJwt.mockRejectedValue(
      new AuthError(AuthErrorCode.TOKEN_EXPIRED, 'Token has expired', 401),
    );

    await expect(requireAuth({ authorization: 'Bearer expired.jwt' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects with 401 when JWT is malformed', async () => {
    mockedValidateJwt.mockRejectedValue(
      new AuthError(AuthErrorCode.UNAUTHORIZED, 'Malformed JWT', 401),
    );

    await expect(requireAuth({ authorization: 'Bearer not.valid' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects with 401 when JWT has wrong issuer', async () => {
    mockedValidateJwt.mockRejectedValue(
      new AuthError(AuthErrorCode.UNAUTHORIZED, 'Invalid token issuer', 401),
    );

    await expect(requireAuth({ authorization: 'Bearer wrong.iss.jwt' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects with 401 when JWT has wrong audience', async () => {
    mockedValidateJwt.mockRejectedValue(
      new AuthError(AuthErrorCode.UNAUTHORIZED, 'Invalid token audience', 401),
    );

    await expect(requireAuth({ authorization: 'Bearer wrong.aud.jwt' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects with 401 when JWT is missing the azp (authorized party) claim', async () => {
    mockedValidateJwt.mockRejectedValue(
      new AuthError(AuthErrorCode.UNAUTHORIZED, 'Invalid token audience', 401),
    );

    await expect(requireAuth({ authorization: 'Bearer no.azp.jwt' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects with 401 when JWT nbf is in the future (token not yet valid)', async () => {
    mockedValidateJwt.mockRejectedValue(
      new AuthError(AuthErrorCode.UNAUTHORIZED, 'Token not yet valid', 401),
    );

    await expect(requireAuth({ authorization: 'Bearer future.nbf.jwt' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('re-throws non-AuthError as UnauthorizedError', async () => {
    mockedValidateJwt.mockRejectedValue(new Error('Unexpected internal error'));

    await expect(requireAuth({ authorization: 'Bearer some.jwt' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

// ─── extractSessionId ─────────────────────────────────────────────────────────

describe('extractSessionId', () => {
  it('extracts session ID from HTTP-only cookie', () => {
    const headers = { cookie: `${SESSION_ID_COOKIE}=sess-abc-123; other=value` };
    expect(extractSessionId(headers)).toBe('sess-abc-123');
  });

  it('returns null when no cookie header is present', () => {
    expect(extractSessionId({})).toBeNull();
  });

  it('returns null when session ID cookie is absent', () => {
    const headers = { cookie: 'unrelated=value; something=else' };
    expect(extractSessionId(headers)).toBeNull();
  });

  it('handles array cookie header values', () => {
    const headers = { cookie: [`${SESSION_ID_COOKIE}=sess-xyz`] };
    expect(extractSessionId(headers)).toBe('sess-xyz');
  });

  it('handles cookie with multiple pairs including session ID', () => {
    const headers = {
      cookie: `${ACCESS_TOKEN_COOKIE}=some.token; ${SESSION_ID_COOKIE}=session-id-value`,
    };
    expect(extractSessionId(headers)).toBe('session-id-value');
  });
});

// ─── buildUserProfileFromPayload ─────────────────────────────────────────────

describe('buildUserProfileFromPayload', () => {
  it('builds a user profile from a valid JWT payload', () => {
    const payload = makePayload();
    const profile = buildUserProfileFromPayload(payload);

    expect(profile.id).toBe('user-123');
    expect(profile.username).toBe('testuser');
    expect(profile.email).toBe('test@example.com');
    expect(profile.firstName).toBe('Test');
    expect(profile.lastName).toBe('User');
    expect(profile.emailVerified).toBe(true);
    expect(profile.accountStatus).toBe('active');
    expect(profile.roles).toEqual(['mc-user']);
  });

  it('uses extractRoles to populate the roles array', () => {
    mockedExtractRoles.mockReturnValue(['mc-admin']);
    const payload = makePayload();
    const profile = buildUserProfileFromPayload(payload);

    expect(mockedExtractRoles).toHaveBeenCalledWith(payload, 'movie-collection-manager');
    expect(profile.roles).toEqual(['mc-admin']);
  });
});

// ─── buildAuthCookies ─────────────────────────────────────────────────────────

describe('buildAuthCookies', () => {
  it('returns three cookie strings (access, refresh, session)', () => {
    const cookies = buildAuthCookies('access-token', 'refresh-token', 'session-id', 900, 604800);
    expect(cookies).toHaveLength(3);
  });

  it('marks all cookies as HttpOnly and SameSite=Strict', () => {
    const cookies = buildAuthCookies('at', 'rt', 'sid', 900, 604800);
    cookies.forEach((c) => {
      expect(c).toMatch(/HttpOnly/);
      expect(c).toMatch(/SameSite=Strict/);
    });
  });

  it('includes session ID in the session cookie', () => {
    const cookies = buildAuthCookies('at', 'rt', 'sess-abc', 900, 604800);
    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_ID_COOKIE}=`));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('sess-abc');
  });

  it('respects the max-age for access token cookie', () => {
    const cookies = buildAuthCookies('at', 'rt', 'sid', 900, 604800);
    const accessCookie = cookies.find((c) => c.startsWith(`${ACCESS_TOKEN_COOKIE}=`));
    expect(accessCookie).toContain('Max-Age=900');
  });
});

// ─── buildClearAuthCookies ────────────────────────────────────────────────────

describe('buildClearAuthCookies', () => {
  it('returns three cookie strings with Max-Age=0 to clear tokens', () => {
    const cookies = buildClearAuthCookies();
    expect(cookies).toHaveLength(3);
    cookies.forEach((c) => expect(c).toMatch(/Max-Age=0/));
  });

  it('clears the session ID cookie', () => {
    const cookies = buildClearAuthCookies();
    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_ID_COOKIE}=`));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/Max-Age=0/);
  });

  it('includes SameSite=Strict on all clear-cookie headers', () => {
    const cookies = buildClearAuthCookies();
    cookies.forEach((c) => expect(c).toMatch(/SameSite=Strict/));
  });

  it('includes HttpOnly on all clear-cookie headers', () => {
    const cookies = buildClearAuthCookies();
    cookies.forEach((c) => expect(c).toMatch(/HttpOnly/));
  });
});
