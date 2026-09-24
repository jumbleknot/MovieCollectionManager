/**
 * Unit tests for the deletion pipeline's ORDER (feature 076, T011 — FR-014, FR-021, FR-022).
 *
 * The order is the feature. Every step could run and the result still be a defect if they run in
 * the wrong sequence, so the sequence is asserted directly rather than inferred from outcomes.
 *
 * Two constraints carry the whole design:
 *
 *   FR-014/FR-015 — the standing permission is given up FIRST, and a failure there destroys
 *   nothing. Feature 073's `tearDownUserBackups` already guarantees this; the pipeline's job is
 *   to call it first and not swallow its throw.
 *
 *   FR-022 — the agent-config document is deleted only AFTER the teardown. The standing
 *   permission is stored inside that document as `offlineRefreshEnc`, so deleting it earlier
 *   destroys the only record of a token still live at Keycloak, with no user left to notice.
 *   That is backlog item #544's failure, reintroduced in a worse form.
 */

import { runAccountDeletion, DELETION_STEPS } from '@/bff-server/account-deletion';
import type { AccountDeletionSteps } from '@/bff-server/account-deletion';

jest.mock('@/bff-server/logger', () => ({
  logger: { audit: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

/** Records the order steps run in, so the sequence can be asserted rather than guessed at. */
function recordingSteps(calls: string[]): AccountDeletionSteps {
  const record =
    <T>(name: string, result: T) =>
    async (): Promise<T> => {
      calls.push(name);
      return result;
    };
  return {
    tearDownUserBackups: record('tearDownUserBackups', undefined),
    deleteCollections: record('deleteCollections', 2),
    removeAgentConfig: record('removeAgentConfig', undefined),
    clearTransientState: record('clearTransientState', undefined),
    terminateSessions: record('terminateSessions', undefined),
    logoutIdpSessions: record('logoutIdpSessions', undefined),
    deleteIdentity: record('deleteIdentity', undefined),
    revokeStepUpToken: record('revokeStepUpToken', undefined),
  } as AccountDeletionSteps;
}

const input = { userId: 'user-1', accessToken: 'at', refreshToken: 'rt' };

describe('runAccountDeletion — ordering', () => {
  it('runs every step exactly once, in the normative order', async () => {
    const calls: string[] = [];

    await runAccountDeletion(input, recordingSteps(calls));

    expect(calls).toEqual([
      'tearDownUserBackups',
      'deleteCollections',
      'removeAgentConfig',
      'clearTransientState',
      'terminateSessions',
      'logoutIdpSessions',
      'deleteIdentity',
      'revokeStepUpToken',
    ]);
  });

  it('gives up the standing permission before destroying anything else', async () => {
    const calls: string[] = [];

    await runAccountDeletion(input, recordingSteps(calls));

    expect(calls[0]).toBe('tearDownUserBackups');
  });

  it('deletes the agent-config document AFTER the teardown, never before', async () => {
    const calls: string[] = [];

    await runAccountDeletion(input, recordingSteps(calls));

    expect(calls.indexOf('removeAgentConfig')).toBeGreaterThan(
      calls.indexOf('tearDownUserBackups'),
    );
  });

  it('deletes the identity last, because it is the only irreversible step', async () => {
    const calls: string[] = [];

    await runAccountDeletion(input, recordingSteps(calls));

    const destructive = calls.filter((c) => c !== 'revokeStepUpToken');
    expect(destructive[destructive.length - 1]).toBe('deleteIdentity');
  });

  it('deletes collections while the step-up token is still usable', async () => {
    const calls: string[] = [];

    await runAccountDeletion(input, recordingSteps(calls));

    expect(calls.indexOf('deleteCollections')).toBeLessThan(
      calls.indexOf('revokeStepUpToken'),
    );
    expect(calls.indexOf('deleteCollections')).toBeLessThan(
      calls.indexOf('terminateSessions'),
    );
  });

  it('passes the step-up access token to the collection deletes, not the session token', async () => {
    const seen: string[] = [];
    const steps = recordingSteps([]);
    steps.deleteCollections = async (_userId: string, accessToken: string) => {
      seen.push(accessToken);
      return 0;
    };

    await runAccountDeletion(input, steps);

    expect(seen).toEqual(['at']);
  });

  it('reports how many collections were destroyed', async () => {
    const result = await runAccountDeletion(input, recordingSteps([]));

    expect(result.collectionsDeleted).toBe(2);
  });

  it('publishes the step order as data, so a reordering is a visible diff', () => {
    expect(DELETION_STEPS).toEqual([
      'tearDownUserBackups',
      'deleteCollections',
      'removeAgentConfig',
      'clearTransientState',
      'terminateSessions',
      'logoutIdpSessions',
      'deleteIdentity',
    ]);
  });
});
