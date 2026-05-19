/**
 * Unit tests for session management middleware (T-152)
 *
 * Covers:
 *   - Session count at 9 → new session allowed
 *   - Session count at 10 → oldest inactive session evicted before creating new
 *   - Session count at 10 (all equal activity) → first (oldest by array order) evicted
 *   - Session state stored in Redis with correct fields
 *   - Session lookup by session ID (found / not found)
 *   - Absolute timeout expiry → null returned, session deleted
 *   - Idle timeout expiry → null returned, session deleted
 *   - Redis unavailability → error propagates gracefully
 */

import {
  createSession,
  getValidSession,
  touchSession,
  terminateSession,
  getActiveSessionCount,
} from '@/bff-server/session-manager';
import type { Session } from '@/types/auth';

// ─── Mock cache-service ───────────────────────────────────────────────────────

jest.mock('@/bff-server/cache-service', () => ({
  cacheSession: jest.fn(),
  deleteSession: jest.fn(),
  getSession: jest.fn(),
  getUserSessionIds: jest.fn(),
  getUserSessionCount: jest.fn(),
}));

import {
  cacheSession,
  deleteSession,
  getSession,
  getUserSessionIds,
  getUserSessionCount,
} from '@/bff-server/cache-service';

const mockedCacheSession = cacheSession as jest.MockedFunction<typeof cacheSession>;
const mockedDeleteSession = deleteSession as jest.MockedFunction<typeof deleteSession>;
const mockedGetSession = getSession as jest.MockedFunction<typeof getSession>;
const mockedGetUserSessionIds = getUserSessionIds as jest.MockedFunction<typeof getUserSessionIds>;
const mockedGetUserSessionCount = getUserSessionCount as jest.MockedFunction<
  typeof getUserSessionCount
>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    sessionId: 'sess-001',
    userId: 'user-123',
    createdAt: now - 60_000,
    lastActivityAt: now - 30_000,
    expiresAt: now + 86_400_000, // 24 hours from now
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedCacheSession.mockResolvedValue(undefined);
  mockedDeleteSession.mockResolvedValue(undefined);
});

// ─── createSession ────────────────────────────────────────────────────────────

describe('createSession', () => {
  it('allows new session when session count is below max (count = 9)', async () => {
    mockedGetUserSessionCount.mockResolvedValue(9);

    const session = await createSession('user-123');

    expect(session.userId).toBe('user-123');
    expect(typeof session.sessionId).toBe('string');
    expect(session.sessionId.length).toBeGreaterThan(0);
    expect(mockedCacheSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
    );
    expect(mockedDeleteSession).not.toHaveBeenCalled();
  });

  it('evicts the oldest inactive session when count reaches max (count = 10)', async () => {
    const now = Date.now();
    mockedGetUserSessionCount.mockResolvedValue(10);

    // Create 10 sessions; sess-10 has the oldest lastActivityAt
    const sessions: Session[] = Array.from({ length: 10 }, (_, i) =>
      makeSession({
        sessionId: `sess-${i + 1}`,
        userId: 'user-123',
        lastActivityAt: now - (i + 1) * 10_000, // sess-1 most recent, sess-10 oldest
      }),
    );

    mockedGetUserSessionIds.mockResolvedValue(sessions.map((s) => s.sessionId));
    sessions.forEach((s) => mockedGetSession.mockResolvedValueOnce(s));

    await createSession('user-123');

    // evictOldestSession sorts by lastActivityAt ascending and removes the first
    expect(mockedDeleteSession).toHaveBeenCalledTimes(1);
    expect(mockedDeleteSession).toHaveBeenCalledWith('sess-10', 'user-123');
    expect(mockedCacheSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
    );
  });

  it('evicts the first session by array order when all sessions have equal lastActivityAt', async () => {
    const now = Date.now();
    mockedGetUserSessionCount.mockResolvedValue(10);

    const fixedActivity = now - 5_000;
    const sessions: Session[] = Array.from({ length: 10 }, (_, i) =>
      makeSession({
        sessionId: `sess-${i + 1}`,
        userId: 'user-123',
        lastActivityAt: fixedActivity, // all equal
      }),
    );

    mockedGetUserSessionIds.mockResolvedValue(sessions.map((s) => s.sessionId));
    sessions.forEach((s) => mockedGetSession.mockResolvedValueOnce(s));

    await createSession('user-123');

    // Sort is stable — first element (sess-1) is evicted when all equal
    expect(mockedDeleteSession).toHaveBeenCalledWith('sess-1', 'user-123');
  });

  it('stores session state in Redis with correct fields', async () => {
    mockedGetUserSessionCount.mockResolvedValue(0);

    const before = Date.now();
    await createSession('user-abc');
    const after = Date.now();

    expect(mockedCacheSession).toHaveBeenCalledTimes(1);
    const stored = mockedCacheSession.mock.calls[0]?.[0] as Session;

    expect(stored.userId).toBe('user-abc');
    expect(typeof stored.sessionId).toBe('string');
    expect(stored.createdAt).toBeGreaterThanOrEqual(before);
    expect(stored.createdAt).toBeLessThanOrEqual(after);
    expect(stored.lastActivityAt).toBe(stored.createdAt);
    expect(stored.expiresAt).toBeGreaterThan(stored.createdAt);
  });
});

// ─── getValidSession ──────────────────────────────────────────────────────────

describe('getValidSession', () => {
  it('returns the session when found and not expired', async () => {
    const session = makeSession({ expiresAt: Date.now() + 86_400_000 });
    mockedGetSession.mockResolvedValue(session);

    const result = await getValidSession('sess-001');

    expect(result).toEqual(session);
  });

  it('returns null when session ID is not found in Redis', async () => {
    mockedGetSession.mockResolvedValue(null);

    const result = await getValidSession('unknown-session');

    expect(result).toBeNull();
    expect(mockedDeleteSession).not.toHaveBeenCalled();
  });

  it('deletes and returns null when absolute timeout has passed', async () => {
    const expired = makeSession({ expiresAt: Date.now() - 1_000 });
    mockedGetSession.mockResolvedValue(expired);

    const result = await getValidSession('sess-001');

    expect(result).toBeNull();
    expect(mockedDeleteSession).toHaveBeenCalledWith('sess-001', expired.userId);
  });

  it('deletes and returns null when idle timeout is exceeded (> 30 minutes idle)', async () => {
    const now = Date.now();
    const idleExpired = makeSession({
      expiresAt: now + 86_400_000,
      lastActivityAt: now - 1_900_000, // ~31.7 minutes ago
    });
    mockedGetSession.mockResolvedValue(idleExpired);

    const result = await getValidSession('sess-001');

    expect(result).toBeNull();
    expect(mockedDeleteSession).toHaveBeenCalledWith('sess-001', idleExpired.userId);
  });
});

// ─── Redis unavailability ─────────────────────────────────────────────────────

describe('Redis unavailability', () => {
  it('propagates error when Redis is unavailable during createSession', async () => {
    mockedGetUserSessionCount.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(createSession('user-123')).rejects.toThrow('ECONNREFUSED');
  });

  it('propagates error when Redis is unavailable during getValidSession', async () => {
    mockedGetSession.mockRejectedValue(new Error('Redis connection lost'));

    await expect(getValidSession('sess-abc')).rejects.toThrow('Redis connection lost');
  });
});

// ─── touchSession ─────────────────────────────────────────────────────────────

describe('touchSession', () => {
  it('updates lastActivityAt for an active session', async () => {
    const before = Date.now();
    const session = makeSession({ lastActivityAt: before - 10_000 });
    mockedGetSession.mockResolvedValue(session);

    await touchSession('sess-001');

    expect(mockedCacheSession).toHaveBeenCalledTimes(1);
    const updated = mockedCacheSession.mock.calls[0]?.[0] as Session;
    expect(updated.lastActivityAt).toBeGreaterThanOrEqual(before);
  });

  it('does nothing when session is not found', async () => {
    mockedGetSession.mockResolvedValue(null);

    await touchSession('nonexistent-session');

    expect(mockedCacheSession).not.toHaveBeenCalled();
  });
});

// ─── terminateSession ─────────────────────────────────────────────────────────

describe('terminateSession', () => {
  it('deletes the session from Redis on termination', async () => {
    await terminateSession('sess-001', 'user-123');

    expect(mockedDeleteSession).toHaveBeenCalledWith('sess-001', 'user-123');
  });
});

// ─── getActiveSessionCount ────────────────────────────────────────────────────

describe('getActiveSessionCount', () => {
  it('returns the current session count for a user', async () => {
    mockedGetUserSessionCount.mockResolvedValue(3);

    const count = await getActiveSessionCount('user-123');

    expect(count).toBe(3);
    expect(mockedGetUserSessionCount).toHaveBeenCalledWith('user-123');
  });
});
