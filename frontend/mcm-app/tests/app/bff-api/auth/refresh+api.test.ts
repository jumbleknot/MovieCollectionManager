/**
 * Unit tests for BFF /refresh endpoint (T-073; server-held tokens: feature 085 US6, FR-021).
 *
 * The client's renewal request now renews the SERVER-HELD tokens of the caller's OWN session: the
 * session comes from the cookie, the refresh token from the session, and nothing in the request can
 * name another session or carry a credential. The response re-sets only the session cookie.
 *
 * FR-006/FR-007 hold by construction, and are still tested (spec 085): the REAL session-tokens
 * module runs here — real sealing, real once-only renewal, real owner check — with only the store,
 * Keycloak and JWT validation mocked. A renewal that resolves to someone other than the session's
 * owner is refused, nothing is kept, and the mismatch is audited.
 */

jest.mock('@/config/env', () => ({
  env: {
    agentConfigEncKey: Buffer.alloc(32, 9).toString('base64'),
    isDevelopment: true,
    sessionAbsoluteTimeoutMs: 86_400_000,
    keycloakClientId: 'movie-collection-manager',
  },
}));
jest.mock('@/bff-server/rate-limiter', () => ({
  checkRefreshRateLimit: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/bff-server/session-manager', () => ({
  readLiveSessionWithTokens: jest.fn(),
  touchSession: jest.fn().mockResolvedValue(undefined),
  terminateSession: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/bff-server/cache-service', () => ({
  setLockIfAbsent: jest.fn().mockResolvedValue(true),
  releaseLockIfHeld: jest.fn().mockResolvedValue(true),
  cacheSessionTokens: jest.fn().mockResolvedValue(undefined),
  getSessionTokensRecord: jest.fn(),
  deleteSession: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/bff-server/keycloak', () => ({
  refreshTokens: jest.fn(),
  revokeToken: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/bff-server/token-service', () => ({
  validateJwt: jest.fn(),
  extractRoles: jest.fn().mockReturnValue(['mc-user']),
}));
jest.mock('@/bff-server/logger', () => ({
  logger: { audit: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { POST } from '@/app/bff-api/auth/refresh+api';
import { checkRefreshRateLimit } from '@/bff-server/rate-limiter';
import { readLiveSessionWithTokens, touchSession } from '@/bff-server/session-manager';
import { cacheSessionTokens, deleteSession } from '@/bff-server/cache-service';
import { refreshTokens, revokeToken } from '@/bff-server/keycloak';
import { validateJwt } from '@/bff-server/token-service';
import { sealSessionTokens } from '@/bff-server/session-tokens';
import { logger } from '@/bff-server/logger';
import { AuthError, AuthErrorCode, RateLimitError } from '@/types/errors';
import type { Session } from '@/types/auth';

const SESSION: Session = {
  sessionId: 'session-abc',
  userId: 'member-a',
  createdAt: Date.now(),
  lastActivityAt: Date.now(),
  expiresAt: Date.now() + 86_400_000,
};

const HELD = {
  accessToken: 'held-access',
  refreshToken: 'held-refresh',
  accessExpiresAt: Date.now() + 300_000,
  refreshExpiresAt: Date.now() + 1_800_000,
};

const grant = (access = 'renewed-access', refresh = 'renewed-refresh') => ({
  access_token: access, refresh_token: refresh, id_token: 'id', token_type: 'Bearer',
  expires_in: 300, refresh_expires_in: 1800, scope: 'openid',
});

function makeRequest(cookieHeader = 'mcm_session_id=session-abc'): Parameters<typeof POST>[0] {
  return {
    url: 'http://localhost/bff-api/auth/refresh',
    headers: new Headers({ cookie: cookieHeader }),
    json: () => Promise.resolve({}),
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  (readLiveSessionWithTokens as jest.Mock).mockResolvedValue({ session: SESSION, tokensRaw: sealSessionTokens(SESSION, HELD) });
  (refreshTokens as jest.Mock).mockResolvedValue(grant());
  (validateJwt as jest.Mock).mockResolvedValue({ payload: { sub: 'member-a' } });
});

describe('POST /bff-api/auth/refresh', () => {
  it('renews the session\'s OWN server-held tokens and re-sets only the session cookie (FR-021)', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    expect(refreshTokens).toHaveBeenCalledWith('held-refresh');
    expect(cacheSessionTokens).toHaveBeenCalledTimes(1);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toMatch(/^mcm_session_id=session-abc;/);
    expect(setCookies.join(';')).not.toContain('renewed');
    expect(touchSession).toHaveBeenCalled();
  });

  it('ignores any refresh-token cookie the client still sends — it is not a credential any more', async () => {
    await POST(makeRequest('mcm_session_id=session-abc; mcm_refresh_token=client-supplied'));
    expect(refreshTokens).toHaveBeenCalledWith('held-refresh');
    expect(refreshTokens).not.toHaveBeenCalledWith('client-supplied');
  });

  it('returns 401 when no session id', async () => {
    const res = await POST(makeRequest(''));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe(AuthErrorCode.SESSION_NOT_FOUND);
  });

  it('returns 401 SESSION_EXPIRED when the session is gone or expired, clearing the cookies', async () => {
    (readLiveSessionWithTokens as jest.Mock).mockResolvedValueOnce({ expired: 'missing' });
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe(AuthErrorCode.SESSION_EXPIRED);
    expect(res.headers.getSetCookie().every((c) => /Max-Age=0/.test(c))).toBe(true);
  });

  it('returns 401 REFRESH_TOKEN_INVALID for a session holding no tokens (pre-085), and ends it', async () => {
    (readLiveSessionWithTokens as jest.Mock).mockResolvedValueOnce({ session: SESSION, tokensRaw: null });
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe(AuthErrorCode.REFRESH_TOKEN_INVALID);
  });

  it('a rejected renewal ends the session: 401 REFRESH_FAILED', async () => {
    (refreshTokens as jest.Mock).mockRejectedValueOnce(new AuthError(AuthErrorCode.REFRESH_FAILED, 'x', 401));
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe(AuthErrorCode.REFRESH_FAILED);
    expect(deleteSession).toHaveBeenCalledWith('session-abc', 'member-a');
  });

  it('a transient renewal failure is a 503 that keeps the session and its cookie', async () => {
    (refreshTokens as jest.Mock).mockRejectedValueOnce(
      new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'down', 503, { retryAfterSeconds: 5 }),
    );
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('returns 429 on rate limit exceeded', async () => {
    (checkRefreshRateLimit as jest.Mock).mockRejectedValueOnce(new RateLimitError(30));
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
  });
});

// Feature 085 US2 (item #607 finding 1, FR-006/FR-007) — kept as a test though it now holds by
// construction (FR-021): a renewal resolving to someone other than the session owner is refused.
describe('POST /bff-api/auth/refresh — session ownership (feature 085)', () => {
  it('refuses a renewal that resolves to another member, keeps nothing, and audits it (US2 AS-1)', async () => {
    (refreshTokens as jest.Mock).mockResolvedValueOnce(grant('b-access', 'b-refresh'));
    (validateJwt as jest.Mock).mockResolvedValueOnce({ payload: { sub: 'member-b' } });

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: AuthErrorCode.SESSION_OWNER_MISMATCH });
    expect(touchSession).not.toHaveBeenCalled();
    expect(cacheSessionTokens).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie().every((c) => /Max-Age=0/.test(c))).toBe(true);
    expect(revokeToken).toHaveBeenCalledWith('b-refresh', 'refresh_token');
    expect(deleteSession).toHaveBeenCalledWith('session-abc', 'member-a');

    const audits = (logger.audit as jest.Mock).mock.calls.filter(([e]) => e === 'session_refresh_owner_mismatch');
    expect(audits).toEqual([['session_refresh_owner_mismatch', { userId: 'member-a' }]]);
    const serialized = JSON.stringify(audits);
    for (const secret of ['session-abc', 'b-access', 'b-refresh', 'member-b']) expect(serialized).not.toContain(secret);
  });

  it('a same-member refresh succeeds unchanged (US2 AS-2)', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(deleteSession).not.toHaveBeenCalled();
  });
});
