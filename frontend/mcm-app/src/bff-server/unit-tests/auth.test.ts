/**
 * Unit tests for the BFF authenticator (T-151; session-only and server-held tokens: feature 085).
 *
 * Since 085 a request authenticates through ONE thing: the `mcm_session_id` cookie. `requireAuth`
 * reads the session, enforces absolute then idle expiry with the true reason, opens the
 * server-held tokens (renewing them when due) and validates the access token on every request.
 * The member's client never holds a token, and a bearer credential is not honoured in any
 * environment (FR-008/FR-009) — it is not even read.
 *
 * The session store and the token sealing are mocked here (their own suites cover them); the JWT
 * validation cases below are the same ones the cookie-token model had, applied to the server-held
 * token.
 */

import * as auth from '@/bff-server/auth';
import {
  requireAuth,
  extractSessionId,
  buildUserProfileFromPayload,
  buildAuthCookies,
  buildClearAuthCookies,
  SESSION_ID_COOKIE,
} from '@/bff-server/auth';
import { AuthError, AuthErrorCode } from '@/types/errors';
import type { JWTPayload, Session } from '@/types/auth';

import { validateJwt, extractRoles } from '@/bff-server/token-service';
import { readLiveSessionWithTokens, touchSession, terminateSession } from '@/bff-server/session-manager';
import { ensureFreshTokens, openSessionTokens } from '@/bff-server/session-tokens';
import { logger } from '@/bff-server/logger';

jest.mock('@/bff-server/token-service', () => ({
  validateJwt: jest.fn(),
  extractRoles: jest.fn().mockReturnValue(['mc-user']),
}));
jest.mock('@/bff-server/session-manager', () => ({
  readLiveSessionWithTokens: jest.fn(),
  touchSession: jest.fn().mockResolvedValue(undefined),
  terminateSession: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/bff-server/session-tokens', () => ({
  openSessionTokens: jest.fn(),
  ensureFreshTokens: jest.fn(),
}));
jest.mock('@/bff-server/logger', () => ({
  logger: { audit: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/config/env', () => ({
  env: {
    keycloakClientId: 'movie-collection-manager',
    isDevelopment: true,
    sessionAbsoluteTimeoutMs: 86_400_000,
  },
}));

const mockedValidateJwt = validateJwt as jest.MockedFunction<typeof validateJwt>;
const mockedExtractRoles = extractRoles as jest.MockedFunction<typeof extractRoles>;
const mockedRead = readLiveSessionWithTokens as jest.MockedFunction<typeof readLiveSessionWithTokens>;
const mockedOpen = openSessionTokens as jest.MockedFunction<typeof openSessionTokens>;
const mockedFresh = ensureFreshTokens as jest.MockedFunction<typeof ensureFreshTokens>;

const SERVER_HELD_ACCESS = 'server.held.access-jwt';

function makePayload(overrides: Partial<JWTPayload> = {}): JWTPayload {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub: 'user-123',
    iss: 'http://localhost:8099/realms/grumpyrobot',
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

const validated = (payload: JWTPayload) => ({ payload, header: { alg: 'RS256', kid: 'key-1', typ: 'JWT' } });

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  return { sessionId: 'session-abc', userId: 'user-123', createdAt: now, lastActivityAt: now, expiresAt: now + 86_400_000, ...overrides };
}

const TOKENS = {
  accessToken: SERVER_HELD_ACCESS,
  refreshToken: 'server.held.refresh',
  accessExpiresAt: Date.now() + 300_000,
  refreshExpiresAt: Date.now() + 1_800_000,
};

const withSession = { cookie: `${SESSION_ID_COOKIE}=session-abc` };

async function refusal(headers: Record<string, string>): Promise<AuthError> {
  try {
    await requireAuth(headers);
  } catch (err) {
    if (err instanceof AuthError) return err;
    throw err;
  }
  throw new Error('expected requireAuth to refuse');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedExtractRoles.mockReturnValue(['mc-user']);
  mockedRead.mockResolvedValue({ session: makeSession(), tokensRaw: 'sealed-record' });
  mockedOpen.mockReturnValue(TOKENS);
  mockedFresh.mockImplementation(async (_session, tokens) => tokens);
  mockedValidateJwt.mockResolvedValue(validated(makePayload()));
});

// ─── requireAuth: the session cookie is the only credential ──────────────────

describe('requireAuth — session cookie', () => {
  it('authenticates through the session and validates the SERVER-HELD token (US6 AS-1)', async () => {
    const result = await requireAuth(withSession);

    expect(mockedRead).toHaveBeenCalledWith('session-abc');
    expect(mockedValidateJwt).toHaveBeenCalledWith(SERVER_HELD_ACCESS);
    expect(result.accessToken).toBe(SERVER_HELD_ACCESS);
    expect(result.user.id).toBe('user-123');
    expect(result.user.username).toBe('testuser');
    expect(result.session.sessionId).toBe('session-abc');
  });

  it('slides the idle window on every authenticated request (FR-023)', async () => {
    await requireAuth(withSession);
    expect(touchSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-abc' }));
  });

  it('uses the renewed tokens when they were due (US6 AS-2)', async () => {
    mockedFresh.mockResolvedValueOnce({ ...TOKENS, accessToken: 'renewed.access-jwt' });
    const result = await requireAuth(withSession);
    expect(mockedValidateJwt).toHaveBeenCalledWith('renewed.access-jwt');
    expect(result.accessToken).toBe('renewed.access-jwt');
  });
});

describe('requireAuth — no bearer credential, in any environment (US3, FR-008/FR-009)', () => {
  it('refuses a bearer credential alone, and never even validates it (US3 AS-1)', async () => {
    const err = await refusal({ authorization: 'Bearer valid.jwt.token' });
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe(AuthErrorCode.UNAUTHORIZED);
    expect(mockedValidateJwt).not.toHaveBeenCalled();
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it('with a bearer AND a session cookie, only the cookie authenticates (US3 AS-2)', async () => {
    await requireAuth({ authorization: 'Bearer some.other.member', ...withSession });
    expect(mockedValidateJwt).toHaveBeenCalledTimes(1);
    expect(mockedValidateJwt).toHaveBeenCalledWith(SERVER_HELD_ACCESS);
  });

  it('there is no helper left that reads a token from request headers', () => {
    expect(auth).not.toHaveProperty('extractRawToken');
  });
});

describe('requireAuth — sessions that are not live', () => {
  it('no cookie: 401 UNAUTHORIZED, clearing the auth cookies', async () => {
    const err = await refusal({});
    expect(err.code).toBe(AuthErrorCode.UNAUTHORIZED);
    expect(err.clearCookies).toEqual(buildClearAuthCookies());
  });

  it('only the retired token cookies: refused and cleared, never migrated (FR-022, US6 AS-6)', async () => {
    const err = await refusal({ cookie: 'mcm_access_token=old.client.jwt; mcm_refresh_token=old.refresh' });
    expect(err.code).toBe(AuthErrorCode.UNAUTHORIZED);
    expect(mockedValidateJwt).not.toHaveBeenCalled();
    const cleared = (err.clearCookies ?? []).map((c) => c.split('=')[0]);
    expect(cleared).toEqual(expect.arrayContaining(['mcm_session_id', 'mcm_access_token', 'mcm_refresh_token']));
  });

  it.each([
    ['absolute', AuthErrorCode.SESSION_ABSOLUTE_TIMEOUT],
    ['idle', AuthErrorCode.SESSION_IDLE_TIMEOUT],
  ] as const)('a session past its %s limit is refused with that reason, and audited (FR-012, FR-023)', async (reason, code) => {
    mockedRead.mockResolvedValueOnce({ expired: reason, userId: 'user-123' });
    const err = await refusal(withSession);
    expect(err.code).toBe(code);
    expect(err.clearCookies).toEqual(buildClearAuthCookies());
    expect(logger.audit).toHaveBeenCalledWith('session_expired', { userId: 'user-123', reason });
    expect(mockedValidateJwt).not.toHaveBeenCalled();
  });

  it('an unknown session is SESSION_NOT_FOUND', async () => {
    mockedRead.mockResolvedValueOnce({ expired: 'missing' });
    expect((await refusal(withSession)).code).toBe(AuthErrorCode.SESSION_NOT_FOUND);
  });

  it('a session with no server-held tokens (created before 085) is ended, not trusted (FR-022)', async () => {
    mockedRead.mockResolvedValueOnce({ session: makeSession(), tokensRaw: null });
    const err = await refusal(withSession);
    expect(err.code).toBe(AuthErrorCode.SESSION_NOT_FOUND);
    expect(terminateSession).toHaveBeenCalledWith('session-abc', 'user-123');
  });

  it('tokens that do not open for this session are ended, not trusted (FR-017)', async () => {
    mockedOpen.mockImplementationOnce(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });
    const err = await refusal(withSession);
    expect(err.code).toBe(AuthErrorCode.SESSION_NOT_FOUND);
    expect(terminateSession).toHaveBeenCalledWith('session-abc', 'user-123');
  });

  it("a server-held token that belongs to someone else is refused and ends the session (FR-006)", async () => {
    mockedValidateJwt.mockResolvedValueOnce(validated(makePayload({ sub: 'someone-else' })));
    const err = await refusal(withSession);
    expect(err.code).toBe(AuthErrorCode.SESSION_OWNER_MISMATCH);
    expect(terminateSession).toHaveBeenCalledWith('session-abc', 'user-123');
    expect(touchSession).not.toHaveBeenCalled();
  });
});

describe('requireAuth — server-side renewal outcomes (FR-019)', () => {
  it('a rejected renewal is a 401 that clears the cookies', async () => {
    mockedFresh.mockRejectedValueOnce(new AuthError(AuthErrorCode.REFRESH_FAILED, 'rejected', 401));
    const err = await refusal(withSession);
    expect(err.statusCode).toBe(401);
    expect(err.clearCookies).toEqual(buildClearAuthCookies());
  });

  it('a transient renewal failure is a retryable 503 that keeps the cookies', async () => {
    mockedFresh.mockRejectedValueOnce(
      new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'down', 503, { retryAfterSeconds: 5 }),
    );
    const err = await refusal(withSession);
    expect(err.statusCode).toBe(503);
    expect(err.retryAfterSeconds).toBe(5);
    expect(err.clearCookies).toBeUndefined();
  });
});

describe('requireAuth — token validation still runs on every request', () => {
  it.each([
    'Invalid token signature',
    'Token expired',
    'Malformed token',
    'Invalid token issuer',
    'Invalid token audience',
    'Missing azp claim',
    'Token not yet valid',
  ])('a server-held token failing validation (%s) is a 401', async (message) => {
    mockedValidateJwt.mockRejectedValueOnce(new AuthError(AuthErrorCode.UNAUTHORIZED, message, 401));
    const err = await refusal(withSession);
    expect(err.statusCode).toBe(401);
  });

  it('a non-AuthError from validation becomes a generic 401', async () => {
    mockedValidateJwt.mockRejectedValueOnce(new Error('jwks fetch exploded'));
    const err = await refusal(withSession);
    expect(err.statusCode).toBe(401);
    expect(err.message).not.toContain('jwks');
  });
});

// ─── extractSessionId ─────────────────────────────────────────────────────────

describe('extractSessionId', () => {
  it('extracts session ID from HTTP-only cookie', () => {
    expect(extractSessionId({ cookie: `${SESSION_ID_COOKIE}=sess-xyz` })).toBe('sess-xyz');
  });

  it('returns null when no cookie header is present', () => {
    expect(extractSessionId({})).toBeNull();
  });

  it('returns null when session ID cookie is absent', () => {
    expect(extractSessionId({ cookie: 'other=value' })).toBeNull();
  });

  it('never reads a session reference from a header', () => {
    expect(extractSessionId({ 'x-session-id': 'sess-from-header' })).toBeNull();
  });

  it('handles array cookie header values', () => {
    expect(extractSessionId({ cookie: [`${SESSION_ID_COOKIE}=sess-arr`] })).toBe('sess-arr');
  });

  it('handles cookie with multiple pairs including session ID', () => {
    expect(extractSessionId({ cookie: `a=1; ${SESSION_ID_COOKIE}=sess-multi; b=2` })).toBe('sess-multi');
  });
});

// ─── buildUserProfileFromPayload ──────────────────────────────────────────────

describe('buildUserProfileFromPayload', () => {
  it('builds a user profile from a valid JWT payload', () => {
    const profile = buildUserProfileFromPayload(makePayload());
    expect(profile.id).toBe('user-123');
    expect(profile.email).toBe('test@example.com');
  });

  it('uses extractRoles to populate the roles array', () => {
    mockedExtractRoles.mockReturnValue(['mc-admin']);
    const payload = makePayload();
    const profile = buildUserProfileFromPayload(payload);
    expect(mockedExtractRoles).toHaveBeenCalledWith(payload, 'movie-collection-manager');
    expect(profile.roles).toEqual(['mc-admin']);
  });
});

// ─── Cookies: the client holds the session reference and nothing else ────────

describe('buildAuthCookies (FR-016)', () => {
  it('sets ONE cookie, the session reference — never a token', () => {
    const cookies = buildAuthCookies('sess-abc');
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(new RegExp(`^${SESSION_ID_COOKIE}=sess-abc;`));
  });

  it('is HttpOnly, SameSite=Strict, Path=/, and lives as long as the session can', () => {
    const [cookie] = buildAuthCookies('sid');
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=86400/);
  });
});

describe('buildClearAuthCookies', () => {
  it('clears the session cookie and both retired token cookies, at their original Paths (FR-022)', () => {
    const cookies = buildClearAuthCookies();
    expect(cookies).toHaveLength(3);
    cookies.forEach((c) => {
      expect(c).toMatch(/Max-Age=0/);
      expect(c).toMatch(/HttpOnly/);
      expect(c).toMatch(/SameSite=Strict/);
    });
    expect(cookies.find((c) => c.startsWith('mcm_session_id='))).toMatch(/Path=\//);
    expect(cookies.find((c) => c.startsWith('mcm_access_token='))).toMatch(/Path=\//);
    expect(cookies.find((c) => c.startsWith('mcm_refresh_token='))).toMatch(/Path=\/bff-api\/auth\/refresh/);
  });
});
