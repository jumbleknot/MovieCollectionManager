/**
 * Unit tests for the pending account-deletion cache pair (feature 076, T005 — FR-011, FR-012).
 *
 * Mirrors the backup-consent pair, and for the same reasons: the PKCE verifier is parked
 * server-side so it never reaches the browser, and the record is keyed by the authenticated
 * user so a callback can only ever complete the request that same user started.
 *
 * The single-use take is what makes a proof unreplayable (FR-010, "already been used once").
 */

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

jest.mock(
  'ioredis',
  () => ({
    __esModule: true,
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

import {
  setPendingAccountDeletion,
  takePendingAccountDeletion,
} from '@/bff-server/cache-service';

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue(undefined);
  mockRedis.del.mockResolvedValue(undefined);
});

describe('pending account-deletion request', () => {
  it('parks the payload under a user-scoped key with a 5-minute TTL', async () => {
    await setPendingAccountDeletion('user-1', '{"state":"s"}');

    expect(mockRedis.set).toHaveBeenCalledWith(
      'account-delete:user-1',
      '{"state":"s"}',
      'EX',
      300,
    );
  });

  it('returns the parked payload', async () => {
    mockRedis.get.mockResolvedValue('{"state":"s"}');

    await expect(takePendingAccountDeletion('user-1')).resolves.toBe('{"state":"s"}');
  });

  it('is single use — the record is deleted on read', async () => {
    mockRedis.get.mockResolvedValue('{"state":"s"}');

    await takePendingAccountDeletion('user-1');

    expect(mockRedis.del).toHaveBeenCalledWith('account-delete:user-1');
  });

  it('returns null and deletes nothing when no request is pending', async () => {
    mockRedis.get.mockResolvedValue(null);

    await expect(takePendingAccountDeletion('user-1')).resolves.toBeNull();
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it('overwrites an earlier request rather than erroring, so a restart is not blocked', async () => {
    await setPendingAccountDeletion('user-1', '{"state":"first"}');
    await setPendingAccountDeletion('user-1', '{"state":"second"}');

    expect(mockRedis.set).toHaveBeenNthCalledWith(
      2,
      'account-delete:user-1',
      '{"state":"second"}',
      'EX',
      300,
    );
  });

  it("keys by user, so one user cannot take another user's pending request", async () => {
    await setPendingAccountDeletion('user-a', '{"state":"a"}');
    await takePendingAccountDeletion('user-b');

    expect(mockRedis.set).toHaveBeenCalledWith(
      'account-delete:user-a',
      expect.any(String),
      'EX',
      300,
    );
    expect(mockRedis.get).toHaveBeenCalledWith('account-delete:user-b');
  });
});
