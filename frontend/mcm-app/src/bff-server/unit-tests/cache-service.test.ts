/**
 * Unit tests for Redis cache service (T-155)
 *
 * Covers:
 *   - Session state cached with correct TTL (600 seconds)
 *   - Cache hit returns stored value
 *   - Cache miss returns null
 *   - TTL expiry causes cache miss (Redis returns null after expiry)
 *   - Redis connection unavailable → error propagates gracefully
 */

import type { Session, UserProfile } from '@/types/auth';

// Import AFTER mocks are registered
import {
  cacheSession,
  getSession,
  deleteSession,
  getUserSessionIds,
  getUserSessionCount,
  cacheUserProfile,
  getCachedUserProfile,
  invalidateUserProfile,
  incrementRateLimit,
  getRateLimitCount,
} from '@/bff-server/cache-service';

// ─── Mock ioredis ─────────────────────────────────────────────────────────────
// jest.mock() is hoisted before variable declarations, so mockRedis must be
// built inside the factory using jest.fn() and exported for access in tests.

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  smembers: jest.fn(),
  sadd: jest.fn(),
  srem: jest.fn(),
  scard: jest.fn(),
  quit: jest.fn(),
};

// Factory captures mockRedis via closure after variable hoisting is resolved
// by using a module-level variable that jest.mock factory can close over.
jest.mock(
  'ioredis',
  () => ({
    __esModule: true,
    // Each new Redis(...) call returns the shared mockRedis instance
    default: jest.fn().mockImplementation(() => mockRedis),
  }),
  { virtual: true },
);

jest.mock('@/config/env', () => ({
  env: {
    redisUrl: 'redis://localhost:6379',
    sessionIdleTimeoutMs: 1_800_000,
    sessionAbsoluteTimeoutMs: 86_400_000,
    maxConcurrentSessions: 10,
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    sessionId: 'sess-abc-123',
    userId: 'user-123',
    createdAt: now - 60_000,
    lastActivityAt: now - 10_000,
    expiresAt: now + 86_400_000,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'user-123',
    username: 'testuser',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    roles: ['mc-user'],
    emailVerified: true,
    accountStatus: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue(undefined);
  mockRedis.del.mockResolvedValue(undefined);
  mockRedis.sadd.mockResolvedValue(undefined);
  mockRedis.srem.mockResolvedValue(undefined);
  mockRedis.expire.mockResolvedValue(undefined);
  mockRedis.incr.mockResolvedValue(1);
  mockRedis.scard.mockResolvedValue(0);
  mockRedis.smembers.mockResolvedValue([]);
});

// ─── cacheSession ─────────────────────────────────────────────────────────────

describe('cacheSession', () => {
  it('stores session state in Redis with the correct 600-second TTL', async () => {
    const session = makeSession();
    await cacheSession(session);

    expect(mockRedis.set).toHaveBeenCalledWith(
      `session:${session.sessionId}`,
      JSON.stringify(session),
      'EX',
      600,
    );
  });

  it('adds the session ID to the user sessions set', async () => {
    const session = makeSession();
    await cacheSession(session);

    expect(mockRedis.sadd).toHaveBeenCalledWith(
      `user-sessions:${session.userId}`,
      session.sessionId,
    );
  });

  it('refreshes TTL on the user sessions set after adding the session', async () => {
    const session = makeSession();
    await cacheSession(session);

    expect(mockRedis.expire).toHaveBeenCalledWith(`user-sessions:${session.userId}`, 600);
  });
});

// ─── getSession ───────────────────────────────────────────────────────────────

describe('getSession', () => {
  it('returns the session object on cache hit', async () => {
    const session = makeSession();
    mockRedis.get.mockResolvedValue(JSON.stringify(session));

    const result = await getSession(session.sessionId);

    expect(result).toEqual(session);
    expect(mockRedis.get).toHaveBeenCalledWith(`session:${session.sessionId}`);
  });

  it('returns null on cache miss (key not present)', async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await getSession('nonexistent-session');

    expect(result).toBeNull();
  });

  it('returns null after TTL expiry (Redis returns null for expired keys)', async () => {
    // Redis automatically evicts keys after their TTL — the client sees null
    mockRedis.get.mockResolvedValue(null);

    const result = await getSession('ttl-expired-session');

    expect(result).toBeNull();
  });
});

// ─── deleteSession ────────────────────────────────────────────────────────────

describe('deleteSession', () => {
  it('removes the session key from Redis', async () => {
    await deleteSession('sess-abc', 'user-123');

    expect(mockRedis.del).toHaveBeenCalledWith('session:sess-abc');
  });

  it('removes the session ID from the user sessions set', async () => {
    await deleteSession('sess-abc', 'user-123');

    expect(mockRedis.srem).toHaveBeenCalledWith('user-sessions:user-123', 'sess-abc');
  });
});

// ─── getUserSessionIds / getUserSessionCount ──────────────────────────────────

describe('getUserSessionIds', () => {
  it('returns all session IDs stored for the user', async () => {
    mockRedis.smembers.mockResolvedValue(['sess-1', 'sess-2', 'sess-3']);

    const ids = await getUserSessionIds('user-123');

    expect(ids).toEqual(['sess-1', 'sess-2', 'sess-3']);
    expect(mockRedis.smembers).toHaveBeenCalledWith('user-sessions:user-123');
  });
});

describe('getUserSessionCount', () => {
  it('returns the cardinality of the user sessions set', async () => {
    mockRedis.scard.mockResolvedValue(5);

    const count = await getUserSessionCount('user-123');

    expect(count).toBe(5);
    expect(mockRedis.scard).toHaveBeenCalledWith('user-sessions:user-123');
  });
});

// ─── User profile cache ───────────────────────────────────────────────────────

describe('cacheUserProfile', () => {
  it('stores user profile in Redis with 5-minute (300-second) TTL', async () => {
    const profile = makeProfile();
    await cacheUserProfile(profile);

    expect(mockRedis.set).toHaveBeenCalledWith(
      `profile:${profile.id}`,
      JSON.stringify(profile),
      'EX',
      300,
    );
  });
});

describe('getCachedUserProfile', () => {
  it('returns the profile object on cache hit', async () => {
    const profile = makeProfile();
    mockRedis.get.mockResolvedValue(JSON.stringify(profile));

    const result = await getCachedUserProfile('user-123');

    expect(result).toEqual(profile);
    expect(mockRedis.get).toHaveBeenCalledWith('profile:user-123');
  });

  it('returns null on cache miss', async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await getCachedUserProfile('missing-user');

    expect(result).toBeNull();
  });
});

describe('invalidateUserProfile', () => {
  it('deletes the profile key from Redis', async () => {
    await invalidateUserProfile('user-123');

    expect(mockRedis.del).toHaveBeenCalledWith('profile:user-123');
  });
});

// ─── Rate limit counters ──────────────────────────────────────────────────────

describe('incrementRateLimit', () => {
  it('increments the counter and returns the updated count', async () => {
    mockRedis.incr.mockResolvedValue(3);

    const count = await incrementRateLimit('login', '192.168.1.1', 60);

    expect(count).toBe(3);
    expect(mockRedis.incr).toHaveBeenCalledWith('rate-limit:login:192.168.1.1');
  });

  it('sets TTL on the first increment (count === 1) to start the window', async () => {
    mockRedis.incr.mockResolvedValue(1);

    await incrementRateLimit('register', 'user@example.com', 86400);

    expect(mockRedis.expire).toHaveBeenCalledWith(
      'rate-limit:register:user@example.com',
      86400,
    );
  });

  it('does not reset TTL on subsequent increments (count > 1)', async () => {
    mockRedis.incr.mockResolvedValue(2);

    await incrementRateLimit('login', '10.0.0.1', 60);

    expect(mockRedis.expire).not.toHaveBeenCalled();
  });
});

describe('getRateLimitCount', () => {
  it('returns the current counter value when key exists', async () => {
    mockRedis.get.mockResolvedValue('7');

    const count = await getRateLimitCount('login', '192.168.1.1');

    expect(count).toBe(7);
    expect(mockRedis.get).toHaveBeenCalledWith('rate-limit:login:192.168.1.1');
  });

  it('returns 0 when key does not exist (no requests yet)', async () => {
    mockRedis.get.mockResolvedValue(null);

    const count = await getRateLimitCount('login', '10.0.0.2');

    expect(count).toBe(0);
  });
});

// ─── Redis unavailability ─────────────────────────────────────────────────────

describe('Redis connection unavailable', () => {
  it('propagates error when a get operation fails (connection lost)', async () => {
    mockRedis.get.mockRejectedValue(new Error('ECONNREFUSED connect ECONNREFUSED 127.0.0.1:6379'));

    await expect(getSession('any-session')).rejects.toThrow('ECONNREFUSED');
  });

  it('propagates error when a set operation fails (connection lost)', async () => {
    mockRedis.set.mockRejectedValue(new Error('Redis connection lost'));

    await expect(cacheSession(makeSession())).rejects.toThrow('Redis connection lost');
  });

  it('throws AuthError when an incr operation fails (connection lost)', async () => {
    mockRedis.incr.mockRejectedValue(new Error('Redis write error'));

    await expect(incrementRateLimit('login', '1.2.3.4', 60)).rejects.toMatchObject({
      message: 'Cache service unavailable',
      statusCode: 503,
    });
  });
});
