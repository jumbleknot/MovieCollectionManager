/**
 * Unit tests for BFF /logout endpoint (T-109; server-held tokens: feature 085 US6 — FR-020).
 *
 * Logout ends the caller's OWN session: the session reference comes from the cookie, which is the
 * credential now that the client holds no token. It revokes the SERVER-HELD refresh token at
 * Keycloak, ends the member's Keycloak SSO sessions, deletes the session with its tokens, and
 * clears the cookies. A client-supplied refresh-token cookie is ignored — it is not a credential.
 */

let mockRejectLogoutRateLimit = false;

jest.mock('@/bff-server/rate-limiter', () => ({
  checkLogoutRateLimit: (..._args: unknown[]) =>
    mockRejectLogoutRateLimit
      ? Promise.reject(new (require('@/types/errors').RateLimitError)(60))
      : Promise.resolve(),
  extractClientIp: () => '127.0.0.1',
}));

jest.mock('@/bff-server/keycloak', () => ({
  revokeToken: jest.fn().mockResolvedValue(undefined),
  logoutUserSessions: jest.fn().mockResolvedValue(undefined),
}));

const SESSION = {
  sessionId: 'session-abc',
  userId: 'user-1',
  createdAt: Date.now(),
  lastActivityAt: Date.now(),
  expiresAt: Date.now() + 86400000,
};

jest.mock('@/bff-server/session-manager', () => ({
  readLiveSessionWithTokens: jest.fn(),
  terminateSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/session-tokens', () => ({
  openSessionTokens: jest.fn(),
}));

jest.mock('@/bff-server/logger', () => ({
  logger: {
    audit: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { POST } from '@/app/bff-api/auth/logout+api';
import { readLiveSessionWithTokens, terminateSession } from '@/bff-server/session-manager';
import { openSessionTokens } from '@/bff-server/session-tokens';
import { revokeToken, logoutUserSessions } from '@/bff-server/keycloak';

function makeRequest(cookie = 'mcm_session_id=session-abc'): Parameters<typeof POST>[0] {
  return {
    url: 'http://localhost/bff-api/auth/logout',
    headers: new Headers({ cookie }),
    json: () => Promise.resolve({}),
  } as unknown as Parameters<typeof POST>[0];
}

describe('POST /bff-api/auth/logout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (readLiveSessionWithTokens as jest.Mock).mockResolvedValue({
      session: SESSION,
      tokensRaw: 'sealed',
    });
    (openSessionTokens as jest.Mock).mockReturnValue({
      accessToken: 'held-access',
      refreshToken: 'held-refresh',
      accessExpiresAt: 0,
      refreshExpiresAt: 0,
    });
  });

  it('returns 200 on successful logout', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('revokes the SERVER-HELD refresh token, never a client-supplied one (FR-020, US6 AS-3)', async () => {
    await POST(makeRequest('mcm_session_id=session-abc; mcm_refresh_token=client-supplied'));
    expect(revokeToken).toHaveBeenCalledTimes(1);
    expect(revokeToken).toHaveBeenCalledWith('held-refresh', 'refresh_token');
  });

  it('ends the Keycloak SSO sessions and deletes this session with its tokens', async () => {
    await POST(makeRequest());
    expect(logoutUserSessions).toHaveBeenCalledWith('user-1');
    expect(terminateSession).toHaveBeenCalledWith('session-abc', 'user-1');
  });

  it('does NOT terminate other sessions', async () => {
    await POST(makeRequest());
    expect(terminateSession).toHaveBeenCalledTimes(1);
  });

  it('clears the session cookie and the retired token cookies', async () => {
    const res = await POST(makeRequest());
    const names = res.headers.getSetCookie().map((c) => c.split('=')[0]);
    expect(names.sort()).toEqual(['mcm_access_token', 'mcm_refresh_token', 'mcm_session_id']);
    expect(res.headers.getSetCookie().every((c) => /Max-Age=0/.test(c))).toBe(true);
  });

  it('with no live session, clears the cookies only — nothing to revoke or end', async () => {
    (readLiveSessionWithTokens as jest.Mock).mockResolvedValueOnce({ expired: 'missing' });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(revokeToken).not.toHaveBeenCalled();
    expect(logoutUserSessions).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toHaveLength(3);
  });

  it('with no session cookie at all, touches nothing', async () => {
    const res = await POST(makeRequest(''));
    expect(res.status).toBe(200);
    expect(readLiveSessionWithTokens).not.toHaveBeenCalled();
    expect(terminateSession).not.toHaveBeenCalled();
  });

  it('a session whose tokens cannot be opened is still ended', async () => {
    (openSessionTokens as jest.Mock).mockImplementationOnce(() => {
      throw new Error('bad record');
    });
    await POST(makeRequest());
    expect(revokeToken).not.toHaveBeenCalled();
    expect(terminateSession).toHaveBeenCalledWith('session-abc', 'user-1');
  });

  it('returns 429 when logout rate limit is exceeded', async () => {
    mockRejectLogoutRateLimit = true;
    const res = await POST(makeRequest());
    mockRejectLogoutRateLimit = false;
    expect(res.status).toBe(429);
  });
});
