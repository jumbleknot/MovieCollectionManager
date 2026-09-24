/**
 * Abort semantics and retry-safety (feature 076, T035/T037 — FR-015, FR-027, FR-028).
 *
 * The question every case here asks is the same: when step N fails, is the system in a state the
 * user can recover from?
 *
 * The first case is the one the whole feature is arranged around. If the standing permission
 * cannot be given up, NOTHING may be destroyed — because destroying the local records of a
 * permission that is still live at the identity provider leaves a token nothing in this system
 * knows about, and after that there is no user left to notice. That is backlog item #544's
 * failure in its worst form.
 */

import { runAccountDeletion, DELETION_STEPS } from '@/bff-server/account-deletion';
import type { AccountDeletionSteps } from '@/bff-server/account-deletion';

const mockAudit = jest.fn();
jest.mock('@/bff-server/logger', () => ({
  logger: {
    audit: (...a: unknown[]) => mockAudit(...a),
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
  },
}));

const input = { userId: 'user-1', accessToken: 'at', refreshToken: 'rt' };

/** Steps that all succeed, recording their names, with one optionally set to throw. */
function steps(calls: string[], failAt?: string): AccountDeletionSteps {
  const make =
    <T>(name: string, result: T) =>
    async (): Promise<T> => {
      calls.push(name);
      if (name === failAt) throw new Error(`${name} exploded`);
      return result;
    };
  return {
    tearDownUserBackups: make('tearDownUserBackups', undefined),
    deleteCollections: make('deleteCollections', 1),
    removeAgentConfig: make('removeAgentConfig', undefined),
    clearTransientState: make('clearTransientState', undefined),
    terminateSessions: make('terminateSessions', undefined),
    logoutIdpSessions: make('logoutIdpSessions', undefined),
    deleteIdentity: make('deleteIdentity', undefined),
    revokeStepUpToken: make('revokeStepUpToken', undefined),
  } as AccountDeletionSteps;
}

beforeEach(() => jest.clearAllMocks());

describe('abort semantics', () => {
  it('destroys NOTHING when the standing permission cannot be given up', async () => {
    const calls: string[] = [];

    await expect(runAccountDeletion(input, steps(calls, 'tearDownUserBackups'))).rejects.toThrow();

    // The teardown itself ran and threw; nothing after it was attempted.
    expect(calls.filter((c) => c !== 'revokeStepUpToken')).toEqual(['tearDownUserBackups']);
  });

  it.each(DELETION_STEPS.map((s) => [s]))(
    'stops at %s and attempts no later destructive step',
    async (failing) => {
      const calls: string[] = [];

      await expect(runAccountDeletion(input, steps(calls, failing))).rejects.toThrow();

      const destructive = calls.filter((c) => c !== 'revokeStepUpToken');
      const expected = DELETION_STEPS.slice(0, DELETION_STEPS.indexOf(failing) + 1);
      expect(destructive).toEqual(expected);
    },
  );

  it('never reports completion when a step failed', async () => {
    await expect(runAccountDeletion(input, steps([], 'deleteCollections'))).rejects.toThrow();

    expect(mockAudit).not.toHaveBeenCalledWith('account_deletion_completed', expect.anything());
  });

  it('reports which step failed, so a failure can be counted rather than guessed at', async () => {
    await expect(runAccountDeletion(input, steps([], 'terminateSessions'))).rejects.toThrow();

    expect(mockAudit).toHaveBeenCalledWith(
      'account_deletion_failed',
      expect.objectContaining({ userId: 'user-1', step: 'terminateSessions' }),
    );
  });

  it('revokes the step-up token even when the deletion failed', async () => {
    const calls: string[] = [];

    await expect(runAccountDeletion(input, steps(calls, 'removeAgentConfig'))).rejects.toThrow();

    // The account still exists on this path, so leaving a second live token set for it would be
    // a standing credential created by the operation meant to destroy one.
    expect(calls).toContain('revokeStepUpToken');
  });

  it('surfaces the original cause, not a revocation error raised on the way out', async () => {
    const s = steps([], 'deleteCollections');
    s.revokeStepUpToken = async () => {
      throw new Error('revocation also failed');
    };

    await expect(runAccountDeletion(input, s)).rejects.toThrow(/deleteCollections exploded/);
  });

  it('does not let a revocation failure turn a SUCCESS into a failure', async () => {
    const s = steps([]);
    s.revokeStepUpToken = async () => {
      throw new Error('revocation failed');
    };

    await expect(runAccountDeletion(input, s)).resolves.toMatchObject({ collectionsDeleted: 1 });
  });
});

describe('retry-safety', () => {
  it('completes on a second run when every step is a no-op the second time', async () => {
    const first: string[] = [];
    await runAccountDeletion(input, steps(first));

    const second: string[] = [];
    await expect(runAccountDeletion(input, steps(second))).resolves.toMatchObject({
      collectionsDeleted: 1,
    });
    expect(second.filter((c) => c !== 'revokeStepUpToken')).toEqual([...DELETION_STEPS]);
  });

  it('completes a retry after a mid-pipeline failure', async () => {
    await expect(runAccountDeletion(input, steps([], 'clearTransientState'))).rejects.toThrow();

    // The retry re-runs the earlier steps against records that are already gone. They are
    // idempotent, so it finishes rather than failing on work the first attempt did.
    await expect(runAccountDeletion(input, steps([]))).resolves.toMatchObject({
      collectionsDeleted: 1,
    });
  });

  it('audits completion exactly once on the successful run', async () => {
    await runAccountDeletion(input, steps([]));

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      'account_deletion_completed',
      expect.objectContaining({ userId: 'user-1', collectionsDeleted: 1 }),
    );
  });
});
