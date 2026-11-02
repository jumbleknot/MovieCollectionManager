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
  readLiveSession,
  readLiveSessionWithTokens,
} from '@/bff-server/session-manager';
import { openSessionTokens } from '@/bff-server/session-tokens';
import type { Session } from '@/types/auth';

import {
  cacheSession,
  cacheSessionTokens,
  deleteSession,
  getSession,
  getSessionWithTokens,
  getUserSessionIds,
  getUserSessionCount,
  touchSessionRecord,
} from '@/bff-server/cache-service';

// ─── Mock cache-service ───────────────────────────────────────────────────────

jest.mock('@/bff-server/cache-service', () => ({
  cacheSession: jest.fn(),
  cacheSessionTokens: jest.fn(),
  deleteSession: jest.fn(),
  getSession: jest.fn(),
  getSessionWithTokens: jest.fn(),
  getUserSessionIds: jest.fn(),
  getUserSessionCount: jest.fn(),
  touchSessionRecord: jest.fn(),
}));
jest.mock('@/config/env', () => ({
  env: {
    maxConcurrentSessions: 10,
    sessionIdleTimeoutMs: 1_800_000,
    sessionAbsoluteTimeoutMs: 86_400_000,
    agentConfigEncKey: Buffer.alloc(32, 3).toString('base64'),
  },
}));

const TOKENS = {
  accessToken: 'eyJ.member-access.sig',
  refreshToken: 'eyJ.member-refresh.sig',
  accessExpiresAt: Date.now() + 300_000,
  refreshExpiresAt: Date.now() + 1_800_000,
};

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

    const session = await createSession('user-123', TOKENS);

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

    await createSession('user-123', TOKENS);

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

    await createSession('user-123', TOKENS);

    // Sort is stable — first element (sess-1) is evicted when all equal
    expect(mockedDeleteSession).toHaveBeenCalledWith('sess-1', 'user-123');
  });

  it('stores session state in Redis with correct fields', async () => {
    mockedGetUserSessionCount.mockResolvedValue(0);

    const before = Date.now();
    await createSession('user-abc', TOKENS);
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

// ─── readLiveSession (feature 085 US5, FR-012) ─────────────────────────────────

describe('readLiveSession', () => {
  it('returns the live session', async () => {
    const session = makeSession();
    mockedGetSession.mockResolvedValue(session);
    await expect(readLiveSession('sess-001')).resolves.toEqual({ session });
  });

  it('reports a missing session as missing, deleting nothing', async () => {
    mockedGetSession.mockResolvedValue(null);
    await expect(readLiveSession('unknown')).resolves.toEqual({ expired: 'missing' });
    expect(mockedDeleteSession).not.toHaveBeenCalled();
  });

  it('reports an absolute expiry as absolute, even when the session is ALSO idle', async () => {
    const now = Date.now();
    const both = makeSession({ expiresAt: now - 1_000, lastActivityAt: now - 3_600_000 });
    mockedGetSession.mockResolvedValue(both);
    await expect(readLiveSession('sess-001')).resolves.toEqual({ expired: 'absolute', userId: both.userId });
    expect(mockedDeleteSession).toHaveBeenCalledWith('sess-001', both.userId);
  });

  it('reports an idle-only expiry as idle', async () => {
    const now = Date.now();
    const idle = makeSession({ expiresAt: now + 86_400_000, lastActivityAt: now - 1_900_000 });
    mockedGetSession.mockResolvedValue(idle);
    await expect(readLiveSession('sess-001')).resolves.toEqual({ expired: 'idle', userId: idle.userId });
    expect(mockedDeleteSession).toHaveBeenCalledWith('sess-001', idle.userId);
  });
});

// ─── Redis unavailability ─────────────────────────────────────────────────────

describe('Redis unavailability', () => {
  it('propagates error when Redis is unavailable during createSession', async () => {
    mockedGetUserSessionCount.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(createSession('user-123', TOKENS)).rejects.toThrow('ECONNREFUSED');
  });

  it('propagates error when Redis is unavailable during getValidSession', async () => {
    mockedGetSession.mockRejectedValue(new Error('Redis connection lost'));

    await expect(getValidSession('sess-abc')).rejects.toThrow('Redis connection lost');
  });
});

// ─── touchSession ─────────────────────────────────────────────────────────────

describe('touchSession', () => {
  // Feature 085: the session record alone, only if it still exists (SET … XX), with no second read —
  // the authenticator already holds the session it just validated.
  it('slides lastActivityAt on the session record only', async () => {
    const before = Date.now();
    const session = makeSession({ lastActivityAt: before - 10_000 });

    await touchSession(session);

    expect(touchSessionRecord).toHaveBeenCalledTimes(1);
    const updated = (touchSessionRecord as jest.Mock).mock.calls[0]?.[0] as Session;
    expect(updated.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(mockedCacheSession).not.toHaveBeenCalled();
    expect(mockedGetSession).not.toHaveBeenCalled();
  });
});

describe('createSession — server-held tokens (feature 085 US6)', () => {
  it('stores the tokens SEALED beside the new session, bound to it', async () => {
    mockedGetUserSessionCount.mockResolvedValue(0);
    const session = await createSession('user-123', TOKENS);

    expect(cacheSessionTokens).toHaveBeenCalledTimes(1);
    const [forSession, raw] = (cacheSessionTokens as jest.Mock).mock.calls[0];
    expect(forSession).toEqual(session);
    expect(raw).not.toContain('eyJ');
    expect(openSessionTokens(session, raw as string)).toEqual(TOKENS);
  });
});

describe('readLiveSessionWithTokens', () => {
  it('returns the live session and its sealed record', async () => {
    const session = makeSession();
    (getSessionWithTokens as jest.Mock).mockResolvedValue({ session, tokensRaw: 'sealed' });
    await expect(readLiveSessionWithTokens('sess-001')).resolves.toEqual({ session, tokensRaw: 'sealed' });
  });

  it('reports absolute before idle, and deletes the expired session', async () => {
    const now = Date.now();
    const both = makeSession({ expiresAt: now - 1, lastActivityAt: now - 3_600_000 });
    (getSessionWithTokens as jest.Mock).mockResolvedValue({ session: both, tokensRaw: 'sealed' });
    await expect(readLiveSessionWithTokens('sess-001')).resolves.toEqual({ expired: 'absolute', userId: both.userId });
    expect(mockedDeleteSession).toHaveBeenCalledWith('sess-001', both.userId);
  });

  it('reports idle, and missing', async () => {
    const now = Date.now();
    const idle = makeSession({ lastActivityAt: now - 1_900_000 });
    (getSessionWithTokens as jest.Mock).mockResolvedValueOnce({ session: idle, tokensRaw: 'sealed' });
    await expect(readLiveSessionWithTokens('sess-001')).resolves.toEqual({ expired: 'idle', userId: idle.userId });
    (getSessionWithTokens as jest.Mock).mockResolvedValueOnce({ session: null, tokensRaw: null });
    await expect(readLiveSessionWithTokens('gone')).resolves.toEqual({ expired: 'missing' });
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

// ─── Concurrent-session cap enforcement (009 FR-018) ──────────────────────────

describe('createSession concurrent-cap trim', () => {
  it('trims the set back to the cap after adding when the count overshoots max', async () => {
    const now = Date.now();
    // Pre-add check sees 11 (a concurrent login already pushed it over), then after
    // adding, the post-add trim observes 11 and must evict down to 10.
    mockedGetUserSessionCount
      .mockResolvedValueOnce(11) // pre-add guard
      .mockResolvedValueOnce(11) // post-add: still over cap → evict
      .mockResolvedValue(10); // after eviction: at cap → stop

    const sessions: Session[] = Array.from({ length: 11 }, (_, i) =>
      makeSession({
        sessionId: `sess-${i + 1}`,
        userId: 'user-123',
        lastActivityAt: now - (i + 1) * 10_000,
      }),
    );
    mockedGetUserSessionIds.mockResolvedValue(sessions.map((s) => s.sessionId));
    mockedGetSession.mockImplementation(
      async (id: string) => sessions.find((s) => s.sessionId === id) ?? null,
    );

    await createSession('user-123', TOKENS);

    // At least one eviction occurred to bring the set down to the cap.
    expect(mockedDeleteSession).toHaveBeenCalled();
  });
});
