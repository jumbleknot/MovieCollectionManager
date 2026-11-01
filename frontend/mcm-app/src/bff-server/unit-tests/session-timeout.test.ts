/**
 * Unit tests for BFF session timeout middleware (T-040a; reason accuracy: feature 085 US5).
 *
 * Before 085 this suite "proved" the absolute-timeout branch by mocking `getValidSession` to return
 * an already-expired session — something the real function never does, because it returned `null`
 * for BOTH timeouts. That is how an absolute expiry reached members and the audit trail as "idle".
 * The mock now returns what `readLiveSession` really returns: a session, or the reason it ended.
 */

import { validateSessionTimeout } from '@/bff-server/session-timeout';
import { AuthErrorCode } from '@/types/errors';
import { logger } from '@/bff-server/logger';

import { readLiveSession, touchSession } from '@/bff-server/session-manager';

jest.mock('@/bff-server/session-manager', () => ({
  readLiveSession: jest.fn(),
  touchSession: jest.fn(),
}));
jest.mock('@/bff-server/logger', () => ({
  logger: { audit: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
const mockedReadLiveSession = readLiveSession as jest.MockedFunction<typeof readLiveSession>;
const mockedTouchSession = touchSession as jest.MockedFunction<typeof touchSession>;

beforeEach(() => {
  jest.clearAllMocks();
});

function makeSession(overrides = {}) {
  const now = Date.now();
  return {
    sessionId: 'sess-123',
    userId: 'user-456',
    createdAt: now - 1000,
    lastActivityAt: now - 1000,
    expiresAt: now + 3600000, // 1 hour from now
    ...overrides,
  };
}

const expiryAudits = () => (logger.audit as jest.Mock).mock.calls.filter(([e]) => e === 'session_expired');

describe('validateSessionTimeout', () => {
  it('accepts a valid session and touches it', async () => {
    mockedReadLiveSession.mockResolvedValue({ session: makeSession() });
    mockedTouchSession.mockResolvedValue(undefined);

    await expect(validateSessionTimeout('sess-123')).resolves.toBeUndefined();
    expect(mockedTouchSession).toHaveBeenCalledWith('sess-123');
  });

  it('throws UNAUTHORIZED when sessionId is null', async () => {
    await expect(validateSessionTimeout(null)).rejects.toMatchObject({
      code: AuthErrorCode.UNAUTHORIZED,
    });
  });

  it('throws SESSION_IDLE_TIMEOUT for an idle expiry, and audits reason idle (US5 AS-2)', async () => {
    mockedReadLiveSession.mockResolvedValue({ expired: 'idle', userId: 'user-456' });
    await expect(validateSessionTimeout('sess-expired')).rejects.toMatchObject({
      code: AuthErrorCode.SESSION_IDLE_TIMEOUT,
    });
    expect(expiryAudits()).toEqual([['session_expired', { userId: 'user-456', reason: 'idle' }]]);
  });

  it('throws SESSION_ABSOLUTE_TIMEOUT for an absolute expiry, and audits reason absolute (US5 AS-1, FR-012)', async () => {
    mockedReadLiveSession.mockResolvedValue({ expired: 'absolute', userId: 'user-456' });
    await expect(validateSessionTimeout('sess-123')).rejects.toMatchObject({
      code: AuthErrorCode.SESSION_ABSOLUTE_TIMEOUT,
    });
    expect(expiryAudits()).toEqual([['session_expired', { userId: 'user-456', reason: 'absolute' }]]);
    expect(mockedTouchSession).not.toHaveBeenCalled();
  });

  it('throws SESSION_NOT_FOUND for an unknown session, with no expiry audit', async () => {
    mockedReadLiveSession.mockResolvedValue({ expired: 'missing' });
    await expect(validateSessionTimeout('sess-unknown')).rejects.toMatchObject({
      code: AuthErrorCode.SESSION_NOT_FOUND,
    });
    expect(expiryAudits()).toHaveLength(0);
  });
});
