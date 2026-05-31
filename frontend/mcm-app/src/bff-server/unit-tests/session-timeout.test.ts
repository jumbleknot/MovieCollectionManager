/**
 * Unit tests for BFF session timeout middleware (T-040a)
 */

import { validateSessionTimeout } from '@/bff-server/session-timeout';
import { AuthErrorCode } from '@/types/errors';

import { getValidSession, touchSession } from '@/bff-server/session-manager';

jest.mock('@/bff-server/session-manager', () => ({
  getValidSession: jest.fn(),
  touchSession: jest.fn(),
}));
const mockedGetValidSession = getValidSession as jest.MockedFunction<typeof getValidSession>;
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

describe('validateSessionTimeout', () => {
  it('accepts a valid session and touches it', async () => {
    mockedGetValidSession.mockResolvedValue(makeSession());
    mockedTouchSession.mockResolvedValue(undefined);

    await expect(validateSessionTimeout('sess-123')).resolves.toBeUndefined();
    expect(mockedTouchSession).toHaveBeenCalledWith('sess-123');
  });

  it('throws UNAUTHORIZED when sessionId is null', async () => {
    await expect(validateSessionTimeout(null)).rejects.toMatchObject({
      code: AuthErrorCode.UNAUTHORIZED,
    });
  });

  it('throws SESSION_IDLE_TIMEOUT when session not found (expired)', async () => {
    mockedGetValidSession.mockResolvedValue(null);

    await expect(validateSessionTimeout('sess-expired')).rejects.toMatchObject({
      code: AuthErrorCode.SESSION_IDLE_TIMEOUT,
    });
  });

  it('throws SESSION_ABSOLUTE_TIMEOUT when absolute timeout exceeded', async () => {
    const now = Date.now();
    const expiredSession = makeSession({ expiresAt: now - 1000 }); // already expired
    mockedGetValidSession.mockResolvedValue(expiredSession);

    await expect(validateSessionTimeout('sess-123')).rejects.toMatchObject({
      code: AuthErrorCode.SESSION_ABSOLUTE_TIMEOUT,
    });
  });
});
