/**
 * Server-held session tokens (feature 085 US6 — FR-017, FR-018, FR-019, FR-006).
 *
 * The member's access and refresh tokens live in the session, sealed with AES-256-GCM, and are
 * renewed on the server — at most once for concurrent requests, because Keycloak rotates refresh
 * tokens and a second use of the same one would end the member's session. The REAL sealing is
 * exercised (no crypto mock); the session store, Keycloak and JWT validation are mocked.
 */

import { randomBytes } from 'crypto';

import {
  sealSessionTokens,
  openSessionTokens,
  tokensFromGrant,
  ensureFreshTokens,
  type SessionTokens,
} from '@/bff-server/session-tokens';
import {
  setLockIfAbsent,
  releaseLockIfHeld,
  cacheSessionTokens,
  getSessionTokensRecord,
  deleteSession,
} from '@/bff-server/cache-service';
import { refreshTokens, revokeToken } from '@/bff-server/keycloak';
import { validateJwt } from '@/bff-server/token-service';
import { logger } from '@/bff-server/logger';
import { AuthError, AuthErrorCode } from '@/types/errors';
import type { Session } from '@/types/auth';

jest.mock('@/config/env', () => ({
  env: { agentConfigEncKey: Buffer.alloc(32, 7).toString('base64') },
}));
jest.mock('@/bff-server/cache-service', () => ({
  setLockIfAbsent: jest.fn(),
  releaseLockIfHeld: jest.fn().mockResolvedValue(true),
  cacheSessionTokens: jest.fn().mockResolvedValue(undefined),
  getSessionTokensRecord: jest.fn(),
  deleteSession: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/bff-server/keycloak', () => ({
  refreshTokens: jest.fn(),
  revokeToken: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/bff-server/token-service', () => ({ validateJwt: jest.fn() }));
jest.mock('@/bff-server/logger', () => ({
  logger: {
    audit: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockedLock = setLockIfAbsent as jest.MockedFunction<typeof setLockIfAbsent>;
const mockedRecord = getSessionTokensRecord as jest.MockedFunction<typeof getSessionTokensRecord>;
const mockedRefresh = refreshTokens as jest.MockedFunction<typeof refreshTokens>;
const mockedValidate = validateJwt as jest.MockedFunction<typeof validateJwt>;

const SESSION: Session = {
  sessionId: 'sess-1',
  userId: 'member-a',
  createdAt: Date.now(),
  lastActivityAt: Date.now(),
  expiresAt: Date.now() + 86_400_000,
};

// JWT-shaped, so "no readable token in the store" can be asserted on the real `eyJ` prefix.
const ACCESS = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from('{"sub":"member-a"}').toString('base64url')}.sig`;
const REFRESH = `eyJhbGciOiJIUzI1NiJ9.${randomBytes(12).toString('base64url')}.sig`;

function tokens(overrides: Partial<SessionTokens> = {}): SessionTokens {
  return {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    accessExpiresAt: Date.now() + 300_000,
    refreshExpiresAt: Date.now() + 1_800_000,
    ...overrides,
  };
}

function grant(access = 'eyJ.renewed-access.sig', refresh = 'eyJ.renewed-refresh.sig') {
  return {
    access_token: access,
    refresh_token: refresh,
    id_token: 'id',
    token_type: 'Bearer',
    expires_in: 300,
    refresh_expires_in: 1800,
    scope: 'openid',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedValidate.mockResolvedValue({ payload: { sub: 'member-a' } } as Awaited<
    ReturnType<typeof validateJwt>
  >);
});

describe('sealing (FR-017, SC-008)', () => {
  it('round-trips for the session it was sealed for', () => {
    const t = tokens();
    expect(openSessionTokens(SESSION, sealSessionTokens(SESSION, t))).toEqual(t);
  });

  it('holds no readable token: the stored record contains no JWT', () => {
    const raw = sealSessionTokens(SESSION, tokens());
    expect(raw).not.toContain('eyJ');
    expect(raw).not.toContain(REFRESH);
  });

  it.each([
    ['another session', { ...SESSION, sessionId: 'sess-2' }],
    ['another member', { ...SESSION, userId: 'member-b' }],
  ])('refuses to open for %s (the AAD binds it)', (_label, other) => {
    const raw = sealSessionTokens(SESSION, tokens());
    expect(() => openSessionTokens(other, raw)).toThrow();
  });

  it('keeps the expiry times in clear, so a session can be aged without the key', () => {
    const t = tokens();
    const record = JSON.parse(sealSessionTokens(SESSION, t)) as Record<string, unknown>;
    expect(record).toMatchObject({
      v: 1,
      accessExpiresAt: t.accessExpiresAt,
      refreshExpiresAt: t.refreshExpiresAt,
    });
    const aged = JSON.stringify({ ...record, accessExpiresAt: 0 });
    expect(openSessionTokens(SESSION, aged).accessExpiresAt).toBe(0);
  });

  it('derives expiry times from a Keycloak grant', () => {
    const t = tokensFromGrant(grant(), 1_000_000);
    expect(t.accessExpiresAt).toBe(1_000_000 + 300_000);
    expect(t.refreshExpiresAt).toBe(1_000_000 + 1_800_000);
  });
});

describe('ensureFreshTokens (FR-018, FR-019)', () => {
  it('returns the tokens untouched while more than 30 s of access lifetime remain', async () => {
    const t = tokens();
    await expect(ensureFreshTokens(SESSION, t)).resolves.toBe(t);
    expect(mockedLock).not.toHaveBeenCalled();
    expect(mockedRefresh).not.toHaveBeenCalled();
  });

  it('renews a token about to expire, stores the result sealed, and checks its owner', async () => {
    mockedLock.mockResolvedValueOnce(true);
    mockedRefresh.mockResolvedValueOnce(grant());
    const renewed = await ensureFreshTokens(
      SESSION,
      tokens({ accessExpiresAt: Date.now() + 5_000 }),
    );

    expect(mockedRefresh).toHaveBeenCalledWith(REFRESH);
    expect(renewed.accessToken).toBe('eyJ.renewed-access.sig');
    expect(mockedValidate).toHaveBeenCalledWith('eyJ.renewed-access.sig');
    const [, stored] = (cacheSessionTokens as jest.Mock).mock.calls[0];
    expect(openSessionTokens(SESSION, stored as string).refreshToken).toBe(
      'eyJ.renewed-refresh.sig',
    );
    expect(releaseLockIfHeld).toHaveBeenCalledWith('session-renew:sess-1', expect.any(String));
  });

  it('force renews even with lifetime left (the client renewal path, FR-021)', async () => {
    mockedLock.mockResolvedValueOnce(true);
    mockedRefresh.mockResolvedValueOnce(grant());
    await ensureFreshTokens(SESSION, tokens(), { force: true });
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
  });

  it('concurrent requests renew ONCE: the loser waits for and uses the winner’s tokens (US6 AS-5)', async () => {
    const stale = tokens({ accessExpiresAt: Date.now() + 1_000 });
    let held = false;
    mockedLock.mockImplementation(async () => {
      if (held) return false;
      held = true;
      return true;
    });
    let storedByWinner: string | null = null;
    (cacheSessionTokens as jest.Mock).mockImplementation(async (_s: Session, raw: string) => {
      storedByWinner = raw;
    });
    mockedRecord.mockImplementation(
      async () => storedByWinner ?? sealSessionTokens(SESSION, stale),
    );
    mockedRefresh.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(grant()), 50)),
    );

    const [a, b] = await Promise.all([
      ensureFreshTokens(SESSION, stale),
      ensureFreshTokens(SESSION, stale),
    ]);

    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe('eyJ.renewed-access.sig');
    expect(b.accessToken).toBe('eyJ.renewed-access.sig');
  });

  it('a rejected renewal ends the session: both keys deleted, audited, 401 REFRESH_FAILED', async () => {
    mockedLock.mockResolvedValueOnce(true);
    mockedRefresh.mockRejectedValueOnce(
      new AuthError(AuthErrorCode.REFRESH_FAILED, 'rejected', 401),
    );
    await expect(ensureFreshTokens(SESSION, tokens({ accessExpiresAt: 0 }))).rejects.toMatchObject({
      statusCode: 401,
      code: AuthErrorCode.REFRESH_FAILED,
    });
    expect(deleteSession).toHaveBeenCalledWith('sess-1', 'member-a');
    expect(logger.audit).toHaveBeenCalledWith('session_renewal_rejected', { userId: 'member-a' });
  });

  it('a transient renewal failure keeps the session and is a retryable 503', async () => {
    mockedLock.mockResolvedValueOnce(true);
    mockedRefresh.mockRejectedValueOnce(
      new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'down', 503, { retryAfterSeconds: 5 }),
    );
    await expect(ensureFreshTokens(SESSION, tokens({ accessExpiresAt: 0 }))).rejects.toMatchObject({
      statusCode: 503,
      code: AuthErrorCode.KEYCLOAK_UNAVAILABLE,
    });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(releaseLockIfHeld).toHaveBeenCalled();
  });

  it('a renewed token for someone else is refused: nothing persisted, its refresh token revoked (FR-006)', async () => {
    mockedLock.mockResolvedValueOnce(true);
    mockedRefresh.mockResolvedValueOnce(grant('eyJ.b-access.sig', 'eyJ.b-refresh.sig'));
    mockedValidate.mockResolvedValueOnce({ payload: { sub: 'member-b' } } as Awaited<
      ReturnType<typeof validateJwt>
    >);

    await expect(ensureFreshTokens(SESSION, tokens({ accessExpiresAt: 0 }))).rejects.toMatchObject({
      statusCode: 401,
      code: AuthErrorCode.SESSION_OWNER_MISMATCH,
    });
    expect(cacheSessionTokens).not.toHaveBeenCalled();
    expect(revokeToken).toHaveBeenCalledWith('eyJ.b-refresh.sig', 'refresh_token');
    expect(deleteSession).toHaveBeenCalledWith('sess-1', 'member-a');
    const audits = (logger.audit as jest.Mock).mock.calls.filter(
      ([e]) => e === 'session_refresh_owner_mismatch',
    );
    expect(audits).toEqual([['session_refresh_owner_mismatch', { userId: 'member-a' }]]);
  });

  it('a loser whose winner ended the session gets 401 SESSION_NOT_FOUND', async () => {
    mockedLock.mockResolvedValueOnce(false);
    mockedRecord.mockResolvedValueOnce(null);
    await expect(ensureFreshTokens(SESSION, tokens({ accessExpiresAt: 0 }))).rejects.toMatchObject({
      statusCode: 401,
      code: AuthErrorCode.SESSION_NOT_FOUND,
    });
  });

  it('a loser that never sees the renewal land gets a retryable 503 SESSION_RENEWAL_PENDING', async () => {
    jest.useFakeTimers();
    try {
      const stale = tokens({ accessExpiresAt: 0 });
      mockedLock.mockResolvedValue(false);
      mockedRecord.mockResolvedValue(sealSessionTokens(SESSION, stale));
      const pending = ensureFreshTokens(SESSION, stale);
      const assertion = expect(pending).rejects.toMatchObject({
        statusCode: 503,
        code: AuthErrorCode.SESSION_RENEWAL_PENDING,
      });
      await jest.advanceTimersByTimeAsync(6_000);
      await assertion;
      expect(mockedRefresh).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
