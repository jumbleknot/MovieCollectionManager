/**
 * Unit tests for BFF /refresh endpoint (T-073)
 */

jest.mock('@/bff-server/rate-limiter', () => ({
  checkRefreshRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/session-manager', () => ({
  getValidSession: jest.fn().mockResolvedValue({ userId: 'user-1' }),
  touchSession: jest.fn().mockResolvedValue(undefined),
  terminateSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/token-service', () => ({
  validateJwt: jest.fn(),
}));

jest.mock('@/bff-server/logger', () => ({
  logger: { audit: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/bff-server/auth', () => ({
  extractSessionId: jest.fn().mockReturnValue('session-abc'),
  buildAuthCookies: jest.fn().mockReturnValue(['mcm_access_token=new-tok']),
  buildClearAuthCookies: jest.fn().mockReturnValue(['mcm_session_id=; Max-Age=0']),
  parseCookies: jest.requireActual('@/bff-server/auth').parseCookies,
  REFRESH_TOKEN_COOKIE: jest.requireActual('@/bff-server/auth').REFRESH_TOKEN_COOKIE,
}));

jest.mock('@/bff-server/keycloak', () => ({
  refreshTokens: jest.fn(),
  revokeToken: jest.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/bff-api/auth/refresh+api';
import { checkRefreshRateLimit } from '@/bff-server/rate-limiter';
import { getValidSession, touchSession, terminateSession } from '@/bff-server/session-manager';
import { extractSessionId } from '@/bff-server/auth';
import { refreshTokens, revokeToken } from '@/bff-server/keycloak';
import { validateJwt } from '@/bff-server/token-service';
import { logger } from '@/bff-server/logger';
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
    (validateJwt as jest.Mock).mockResolvedValue({ payload: { sub: 'user-1' } });
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

// Feature 085 US2 (item #607 finding 1, FR-006/FR-007): refresh extends ONLY the caller's own
// session. A renewal credential that resolves to a different member than the session's owner is
// refused before the session is touched or any credential is issued.
describe('POST /bff-api/auth/refresh — session ownership (feature 085)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getValidSession as jest.Mock).mockResolvedValue({ userId: 'member-a' });
    (refreshTokens as jest.Mock).mockResolvedValue({
      access_token: 'b-access', refresh_token: 'b-refresh', expires_in: 900, refresh_expires_in: 1800,
    });
  });

  it("refuses member B's renewal credential on member A's session (US2 AS-1)", async () => {
    (validateJwt as jest.Mock).mockResolvedValue({ payload: { sub: 'member-b' } });
    const res = await POST(makeRequest('mcm_session_id=session-abc; mcm_refresh_token=b-refresh-cookie'));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: AuthErrorCode.SESSION_OWNER_MISMATCH });
    expect(touchSession).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie().every((c) => /Max-Age=0/.test(c))).toBe(true);
    expect(res.headers.getSetCookie().join(';')).not.toContain('b-access');
    // The tokens just minted for B are not left live, and the corrupted session is ended.
    expect(revokeToken).toHaveBeenCalledWith('b-refresh', 'refresh_token');
    expect(terminateSession).toHaveBeenCalledWith('session-abc', 'member-a');

    const audits = (logger.audit as jest.Mock).mock.calls.filter(([e]) => e === 'session_refresh_owner_mismatch');
    expect(audits).toHaveLength(1);
    expect(audits[0][1]).toEqual({ userId: 'member-a' });
    const serialized = JSON.stringify(audits);
    for (const secret of ['session-abc', 'b-access', 'b-refresh', 'member-b']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('a same-member refresh succeeds unchanged (US2 AS-2)', async () => {
    (validateJwt as jest.Mock).mockResolvedValue({ payload: { sub: 'member-a' } });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(touchSession).toHaveBeenCalledWith('session-abc');
    expect(terminateSession).not.toHaveBeenCalled();
  });
});
