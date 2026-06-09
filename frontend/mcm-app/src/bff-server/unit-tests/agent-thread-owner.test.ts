/**
 * Unit tests for agent thread-ownership binding (implementation-review 2026-06-09 follow-up).
 *
 * Security: a CopilotKit `thread_id` is client-supplied and (before this) not bound to the
 * authenticated user, so a user could resume another user's checkpointed thread and see that
 * proposal's preview. `enforceAgentThreadOwnership` claims a thread for the first user who uses
 * it (Redis SET NX) and rejects (403, no run) any later mismatch — fail-closed.
 */

import { enforceAgentThreadOwnership } from '@/bff-server/agent-thread-owner';
import { claimAgentThreadOwner } from '@/bff-server/cache-service';
import { ForbiddenError } from '@/types/errors';

jest.mock('@/bff-server/cache-service', () => ({
  claimAgentThreadOwner: jest.fn(),
}));

const mockedClaim = claimAgentThreadOwner as jest.MockedFunction<typeof claimAgentThreadOwner>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('enforceAgentThreadOwnership', () => {
  it('allows when the thread is unclaimed (first use claims it for this user)', async () => {
    mockedClaim.mockResolvedValue('user-1'); // claim returns the now-owner
    await expect(enforceAgentThreadOwnership('user-1', 'thread-9')).resolves.toBeUndefined();
    expect(mockedClaim).toHaveBeenCalledWith('thread-9', 'user-1', expect.any(Number));
  });

  it('allows when the thread is already owned by the same user', async () => {
    mockedClaim.mockResolvedValue('user-1');
    await expect(enforceAgentThreadOwnership('user-1', 'thread-9')).resolves.toBeUndefined();
  });

  it('throws ForbiddenError (403, no run) when the thread is owned by another user', async () => {
    mockedClaim.mockResolvedValue('user-OTHER'); // claim reveals a different owner
    await expect(enforceAgentThreadOwnership('user-1', 'thread-9')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('is a no-op when there is no threadId to bind (nothing to protect)', async () => {
    await expect(enforceAgentThreadOwnership('user-1', undefined)).resolves.toBeUndefined();
    await expect(enforceAgentThreadOwnership('user-1', '')).resolves.toBeUndefined();
    await expect(enforceAgentThreadOwnership('user-1', '   ')).resolves.toBeUndefined();
    expect(mockedClaim).not.toHaveBeenCalled();
  });
});
