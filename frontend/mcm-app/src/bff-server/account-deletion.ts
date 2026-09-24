/**
 * The account-deletion pipeline (feature 076, FR-014 through FR-022).
 *
 * THE ORDER IS THE FEATURE. Every step below could run and the result still be a defect if they
 * run in the wrong sequence. Two constraints carry the whole design:
 *
 *   The standing permission is given up FIRST, and a failure there destroys nothing.
 *   `tearDownUserBackups` already guarantees that — it revokes at the identity provider before
 *   deleting any local record, and throws having deleted nothing if the revocation fails. This
 *   module's job is to call it first and not swallow the throw.
 *
 *   The identity is deleted LAST, because it is the only irreversible step. Once the account is
 *   gone there is no identity left to authenticate as, so nothing that needed the user to exist
 *   can be retried.
 *
 * WHY THE AGENT CONFIG IS NOT DELETED EARLY. The standing permission is stored inside that
 * document as `offlineRefreshEnc`. Removing the document before the teardown would destroy the
 * only record of a token still live at Keycloak, leaving nothing in this system that knows it
 * exists — backlog item #544's failure, in a worse form, because no user remains to notice.
 *
 * WHAT THIS MODULE MUST NEVER DO. It must not construct a destination driver or import
 * `backup-destination-driver` / `backup-retention`. The artifacts at the user's own destination
 * are their property, at storage they own and pay for (FR-023). The means to delete them exists
 * one call away for retention pruning, and "clean up their backups" is a plausible, wrong
 * reading of this feature. `account-deletion-no-driver.test.ts` pins that.
 */

import { tearDownUserBackups } from '@/bff-server/backup-offline-token';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { deleteUser, logoutUserSessions, revokeToken } from '@/bff-server/keycloak';
import { terminateAllSessions } from '@/bff-server/session-manager';
import { remove as removeAgentConfig } from '@/bff-server/agent-config-store';
import {
  invalidateUserProfile,
  clearAgentUiSnapshot,
  clearAgentImportFile,
  takeBackupConsentRequest,
} from '@/bff-server/cache-service';
import { logger } from '@/bff-server/logger';

/**
 * The destructive steps, in their normative order.
 *
 * Published as data so that a reordering shows up as a diff on a named list rather than as a
 * quiet edit inside a function body. `account-deletion-order.test.ts` asserts against it.
 */
export const DELETION_STEPS = [
  'tearDownUserBackups',
  'deleteCollections',
  'removeAgentConfig',
  'clearTransientState',
  'terminateSessions',
  'logoutIdpSessions',
  'deleteIdentity',
] as const;

export type DeletionStep = (typeof DELETION_STEPS)[number];

export interface AccountDeletionInput {
  userId: string;
  /** The STEP-UP access token, not the session's. See `defaultSteps.deleteCollections`. */
  accessToken: string;
  /** The step-up refresh token, revoked at the end on both the success and the failure path. */
  refreshToken: string;
}

export interface AccountDeletionResult {
  collectionsDeleted: number;
}

export interface AccountDeletionSteps {
  tearDownUserBackups(userId: string): Promise<void>;
  deleteCollections(userId: string, accessToken: string): Promise<number>;
  removeAgentConfig(userId: string): Promise<void>;
  clearTransientState(userId: string): Promise<void>;
  terminateSessions(userId: string): Promise<void>;
  logoutIdpSessions(userId: string): Promise<void>;
  deleteIdentity(userId: string): Promise<void>;
  revokeStepUpToken(refreshToken: string): Promise<void>;
}

interface CollectionSummary {
  id: string;
}

export const defaultSteps: AccountDeletionSteps = {
  tearDownUserBackups: (userId) => tearDownUserBackups(userId),

  /**
   * List the user's collections and delete each one.
   *
   * The USER'S OWN identity performs this, via the step-up access token rather than the session
   * cookie's. The step-up token was minted seconds ago and cannot be near expiry, whereas the
   * session's may be — a user has just spent time at a login form and possibly a TOTP prompt.
   * An expiry in the middle of this loop is the most expensive place in the system for one.
   *
   * mc-service's DAC layer enforces ownership, so this cannot reach another user's collection
   * even if the identity were somehow wrong.
   *
   * A 404 COUNTS AS SUCCESS. A retry after a partial failure re-issues deletes for collections
   * the first attempt already removed; treating that as an error would make the retry fail
   * precisely where it had otherwise worked. This is one of only two places where retry-safety
   * had to be written rather than inherited.
   */
  async deleteCollections(_userId, accessToken) {
    const client = createMcServiceClient(accessToken);
    const { data } = await client.get('/api/v1/collections');
    const collections = (Array.isArray(data) ? data : []) as CollectionSummary[];

    let deleted = 0;
    for (const { id } of collections) {
      try {
        await client.delete(`/api/v1/collections/${encodeURIComponent(id)}`);
        deleted += 1;
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404) {
          deleted += 1;
          continue;
        }
        throw err;
      }
    }
    return deleted;
  },

  removeAgentConfig: (userId) => removeAgentConfig(userId),

  /**
   * Redis state keyed by the user. Each of these is unconditional and so already retry-safe.
   *
   * The agent thread-owner claims are deliberately absent: they are keyed by `thread_id`, not by
   * user, so they are not enumerable here. They carry the session's absolute TTL and expire on
   * their own, and hold an opaque user id as a value rather than any personal data.
   */
  async clearTransientState(userId) {
    await invalidateUserProfile(userId);
    await clearAgentUiSnapshot(userId);
    await clearAgentImportFile(userId);
    await takeBackupConsentRequest(userId);
  },

  terminateSessions: (userId) => terminateAllSessions(userId),

  /**
   * Terminate the SSO session at the identity provider, not only this application's.
   *
   * Deleting the user subsumes this, but the deletion can still fail — and this ordering means
   * such a failure leaves the user signed out rather than still signed in with half their data
   * gone. The constitution requires IAM-level termination independently of token revocation.
   */
  logoutIdpSessions: (userId) => logoutUserSessions(userId),

  deleteIdentity: (userId) => deleteUser(userId),

  revokeStepUpToken: (refreshToken) => revokeToken(refreshToken, 'refresh_token'),
};

/**
 * Run the ordered deletion.
 *
 * Throws on the first failing step, having attempted nothing after it. The caller reports that
 * the account was NOT deleted (FR-028) — never a partial success — and the user retries.
 *
 * The step-up refresh token is revoked in a `finally`, so it is given up on the failure path
 * too. That path is the one that matters: the account still exists there, and leaving a second
 * live token set for it would be a standing credential created by the very operation meant to
 * destroy one.
 */
export async function runAccountDeletion(
  input: AccountDeletionInput,
  steps: AccountDeletionSteps = defaultSteps,
): Promise<AccountDeletionResult> {
  const { userId, accessToken, refreshToken } = input;

  try {
    await steps.tearDownUserBackups(userId);
    const collectionsDeleted = await steps.deleteCollections(userId, accessToken);
    await steps.removeAgentConfig(userId);
    await steps.clearTransientState(userId);
    await steps.terminateSessions(userId);
    await steps.logoutIdpSessions(userId);
    await steps.deleteIdentity(userId);

    logger.audit('account_deletion_completed', { userId, collectionsDeleted });
    return { collectionsDeleted };
  } finally {
    // Best effort, and deliberately not allowed to mask the outcome: if the deletion succeeded
    // the account is already gone and its tokens with it, and if it failed the caller must see
    // the real cause rather than a revocation error raised on the way out.
    await steps.revokeStepUpToken(refreshToken).catch(() => undefined);
  }
}
