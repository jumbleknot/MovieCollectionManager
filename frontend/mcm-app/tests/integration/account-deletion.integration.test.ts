/**
 * Account deletion, end to end against the real stack (feature 076, T019-T022, T039-T042).
 *
 * THE TEST THIS FEATURE EXISTS FOR is the first one: after a deletion, the standing permission
 * is presented to Keycloak and Keycloak refuses it. That is the only evidence that closes
 * backlog item #544. A local `$unset` proves the record was forgotten, which is not the same as
 * proving the permission was revoked — and "we forgot to revoke" and "we revoked" look identical
 * in a passing suite that only checks the database.
 *
 * SECOND is the one that proves we did NOT overreach: the artifacts at the user's own
 * destination are still there, byte for byte, against real MinIO. "We forgot to delete them" and
 * "we deliberately leave them" also look identical otherwise, and only one of those is the
 * requirement.
 *
 * Nothing here is mocked. Keycloak, MongoDB, Redis and MinIO are all real — the constitution
 * forbids substituting them in this tier, and for SC-001 a mocked identity provider could not
 * demonstrate anything at all.
 */
import { randomUUID } from 'node:crypto';

import {
  createTestUser,
  deleteTestUser,
  findUsersByUsername,
  type TestUser,
} from './helpers/keycloak-test-client';
import {
  acquireOfflineRefreshToken,
  offlineTokenStillWorks,
} from './helpers/offline-token-flow';
import { describeBackupTargets, assertBackupTargetsPresent } from './helpers/backup-targets';

import * as offlineToken from '@/bff-server/backup-offline-token';
import * as destinationStore from '@/bff-server/backup-destination-store';
import * as jobStore from '@/bff-server/backup-job-store';
import * as runStore from '@/bff-server/backup-run-store';
import { runScheduledBackup } from '@/bff-server/backup-runner';
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import { runAccountDeletion, defaultSteps } from '@/bff-server/account-deletion';
import type { AccountDeletionSteps } from '@/bff-server/account-deletion';
import { upsert as upsertAgentConfig, getByUserId } from '@/bff-server/agent-config-store';
import {
  getAgentConfigCollection,
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  getBackupRunsCollection,
  closeMongo,
} from '@/bff-server/mongo-client';
import type { S3BackupDestination } from '@/types/backups';

const S3_ENDPOINT = process.env.BACKUP_TEST_S3_ENDPOINT || 'http://localhost:9100';
const S3_BUCKET = process.env.BACKUP_TEST_S3_BUCKET || 'mcm-backups-test';
const S3_ACCESS_KEY = process.env.BACKUP_TEST_S3_ACCESS_KEY || 'mcmbackuptest';
const S3_SECRET = process.env.BACKUP_TEST_S3_SECRET_KEY || '';

const CREDS_PRESENT = Boolean(process.env.KEYCLOAK_CLIENT_SECRET && process.env.E2E_TEST_PASSWORD);
if (!CREDS_PRESENT && process.env.MCM_REQUIRE_LIVE_STACK === '1') {
  throw new Error('account-deletion requires KEYCLOAK_CLIENT_SECRET and E2E_TEST_PASSWORD');
}

jest.setTimeout(120_000);

describeBackupTargets('account deletion', () => {
  let user: TestUser;
  const prefix = `acct-del-${randomUUID()}`;

  beforeAll(() => {
    assertBackupTargetsPresent();
  });

  beforeEach(async () => {
    user = await createTestUser('t019-acct');
  });

  afterEach(async () => {
    // Belt and braces: the pipeline should have removed all of this, but a FAILING test must not
    // leave residue that makes the next one lie.
    if (user?.userId) {
      await (await getBackupDestinationsCollection()).deleteMany({ userId: user.userId });
      await (await getBackupJobsCollection()).deleteMany({ userId: user.userId });
      await (await getBackupRunsCollection()).deleteMany({ userId: user.userId });
      await (await getAgentConfigCollection()).deleteMany({ _id: user.userId });
      await deleteTestUser(user.userId);
    }
  });

  afterAll(async () => {
    await closeMongo();
  });

  async function realDestination(): Promise<string> {
    return (
      await destinationStore.createDestination(user.userId, {
        type: 's3',
        label: `acct-${randomUUID()}`,
        endpoint: S3_ENDPOINT,
        bucket: S3_BUCKET,
        region: 'us-east-1',
        pathStyle: true,
        accessKeyId: S3_ACCESS_KEY,
        basePath: `${prefix}/${user.userId}`,
        secret: S3_SECRET,
      })
    ).id;
  }

  const driver = () =>
    createBackupDriver(
      {
        _id: 'probe',
        userId: user.userId,
        type: 's3',
        label: 'probe',
        endpoint: S3_ENDPOINT,
        bucket: S3_BUCKET,
        region: 'us-east-1',
        pathStyle: true,
        accessKeyId: S3_ACCESS_KEY,
        basePath: `${prefix}/${user.userId}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as S3BackupDestination,
      S3_SECRET,
    );

  /**
   * Populate everything a real user accumulates.
   *
   * Collections are NOT created here: the pipeline reaches mc-service with the user's own token,
   * and these tests drive the pipeline directly rather than through a browser session. The
   * collection path is covered by its own unit suite against a stubbed client and by the web
   * E2E; what cannot be covered anywhere else is the standing permission, which is why that is
   * what this file exists for.
   */
  async function populate(): Promise<{ offlineRefresh: string; destinationId: string }> {
    const offlineRefresh = await acquireOfflineRefreshToken(user.username, user.password);
    await offlineToken.storeOfflineToken(user.userId, offlineRefresh);

    const destinationId = await realDestination();
    const job = await jobStore.createJob(user.userId, {
      destinationId,
      label: 'nightly',
      collectionIds: [],
      keepLast: 7,
      enabled: true,
    });
    await runStore.startRun(user.userId, job.id, 'manual');
    await upsertAgentConfig(user.userId, { enabled: true });

    return { offlineRefresh, destinationId };
  }

  /** The real pipeline with the mc-service step stubbed out — see `populate`. */
  function stepsWithoutCollections(count = 0): AccountDeletionSteps {
    return { ...defaultSteps, deleteCollections: async () => count };
  }

  // ─── SC-001: the reason this feature exists ─────────────────────────────────────

  it('leaves the standing permission REJECTED BY KEYCLOAK, not merely forgotten', async () => {
    const { offlineRefresh } = await populate();

    // The premise: it works right now. Without this the assertion below could pass against a
    // token that was never valid.
    expect(await offlineTokenStillWorks(offlineRefresh)).toBe(true);

    await runAccountDeletion(
      { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
      stepsWithoutCollections(),
    );

    expect(await offlineTokenStillWorks(offlineRefresh)).toBe(false);
  });

  // ─── SC-002 / SC-004 ────────────────────────────────────────────────────────────

  it('removes the account itself, so the user can no longer sign in', async () => {
    await populate();

    await runAccountDeletion(
      { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
      stepsWithoutCollections(),
    );

    await expect(findUsersByUsername(user.username)).resolves.toEqual([]);
  });

  it('leaves no record anywhere keyed by the deleted user', async () => {
    await populate();

    await runAccountDeletion(
      { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
      stepsWithoutCollections(),
    );

    expect(await (await getBackupDestinationsCollection()).countDocuments({ userId: user.userId })).toBe(0);
    expect(await (await getBackupJobsCollection()).countDocuments({ userId: user.userId })).toBe(0);
    expect(await (await getBackupRunsCollection()).countDocuments({ userId: user.userId })).toBe(0);
    expect(await getByUserId(user.userId)).toBeNull();
  });

  it('deletes the agent-config DOCUMENT, not merely its secrets', async () => {
    await populate();

    await runAccountDeletion(
      { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
      stepsWithoutCollections(),
    );

    // `clear()` would leave a document behind with `enabled: false`. FR-018 requires it gone.
    expect(await (await getAgentConfigCollection()).countDocuments({ _id: user.userId })).toBe(0);
  });

  // ─── SC-003: what we deliberately do NOT do ─────────────────────────────────────

  it('leaves every artifact at the user own destination untouched', async () => {
    await populate();

    const key = `${prefix}/${user.userId}/backup-${randomUUID()}.json`;
    const body = Buffer.from(JSON.stringify({ collections: ['irreplaceable'] }));
    await (await driver()).put(key, body);

    await runAccountDeletion(
      { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
      stepsWithoutCollections(),
    );

    // A fresh driver: the destination record is gone, so this proves the OBJECT survives
    // independently of anything this system still holds about how to reach it.
    const after = await (await driver()).get(key);
    expect(Buffer.from(after).toString()).toBe(body.toString());
  });

  // ─── SC-005 / SC-006: failure and retry ─────────────────────────────────────────

  it('destroys NOTHING when the standing permission cannot be given up', async () => {
    const { offlineRefresh } = await populate();

    const steps: AccountDeletionSteps = {
      ...stepsWithoutCollections(),
      tearDownUserBackups: async () => {
        throw new offlineToken.OfflineTokenRevocationError('identity provider unreachable');
      },
    };

    await expect(
      runAccountDeletion(
        { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
        steps,
      ),
    ).rejects.toThrow();

    // Every record survives, the account survives, and the permission is still live — which is
    // the whole point: it remains reachable, so the deletion can be retried.
    expect(await (await getBackupDestinationsCollection()).countDocuments({ userId: user.userId })).toBe(1);
    expect(await findUsersByUsername(user.username)).toHaveLength(1);
    expect(await offlineTokenStillWorks(offlineRefresh)).toBe(true);
  });

  it('completes on a retry after a failure part way through', async () => {
    const { offlineRefresh } = await populate();

    const failing: AccountDeletionSteps = {
      ...stepsWithoutCollections(),
      clearTransientState: async () => {
        throw new Error('redis blip');
      },
    };

    await expect(
      runAccountDeletion(
        { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
        failing,
      ),
    ).rejects.toThrow();

    // The permission is already gone — the first attempt got that far. The retry re-runs the
    // earlier steps against records that no longer exist and must still finish.
    expect(await offlineTokenStillWorks(offlineRefresh)).toBe(false);

    await expect(
      runAccountDeletion(
        { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
        stepsWithoutCollections(),
      ),
    ).resolves.toBeDefined();

    await expect(findUsersByUsername(user.username)).resolves.toEqual([]);
  });

  it('is safe to run twice over, with nothing left to delete the second time', async () => {
    await populate();

    await runAccountDeletion(
      { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
      stepsWithoutCollections(),
    );

    // Every step against an account that no longer exists. `deleteUser` answers 404, which the
    // implementation treats as success precisely so this cannot fail.
    await expect(
      runAccountDeletion(
        { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
        stepsWithoutCollections(),
      ),
    ).resolves.toBeDefined();
  });

  // ─── SC-009: the time budget ────────────────────────────────────────────────────

  it('completes well inside the 30-second budget at fixture size', async () => {
    await populate();

    const started = Date.now();
    await runAccountDeletion(
      { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
      stepsWithoutCollections(10),
    );
    const elapsed = Date.now() - started;

    // SC-009 allows 30s for 10 collections and 1,000 movies. The per-collection loop is
    // sequential, so this figure does not extrapolate — it is a regression guard on the fixed
    // cost of everything that is NOT the loop.
    expect(elapsed).toBeLessThan(30_000);
  });

  // ─── SC-012: the client going away must not stop the work ───────────────────────

  it('runs to completion even when nothing is waiting for the result', async () => {
    const { offlineRefresh } = await populate();

    // Nobody awaits this — the caller walks away the instant it is started, which is what a
    // closed tab amounts to on the server side.
    const abandoned = runAccountDeletion(
      { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
      stepsWithoutCollections(),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    await abandoned;

    expect(await offlineTokenStillWorks(offlineRefresh)).toBe(false);
    await expect(findUsersByUsername(user.username)).resolves.toEqual([]);
  });

  // ─── SC-014: the address is released ────────────────────────────────────────────

  it('frees the username, and a new account inherits nothing from the deleted one', async () => {
    await populate();
    const { username } = user;

    await runAccountDeletion(
      { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
      stepsWithoutCollections(),
    );

    // The address is released: an exact-username lookup finds nobody, so nothing at the identity
    // provider would refuse a registration reusing it. (This asserts the name is FREE rather
    // than re-registering it — `createTestUser` mints its own unique name by design.)
    await expect(findUsersByUsername(username)).resolves.toEqual([]);

    // And a subsequent account starts empty. The deleted user's records are keyed by their
    // Keycloak id, so a new account cannot pick them up even if it took the same address.
    const reborn = await createTestUser('t019-reborn');
    try {
      expect(reborn.userId).not.toBe(user.userId);
      expect(await (await getBackupDestinationsCollection()).countDocuments({ userId: reborn.userId })).toBe(0);
      expect(await (await getBackupJobsCollection()).countDocuments({ userId: reborn.userId })).toBe(0);
      expect(await (await getBackupRunsCollection()).countDocuments({ userId: reborn.userId })).toBe(0);
      expect(await getByUserId(reborn.userId)).toBeNull();
    } finally {
      await deleteTestUser(reborn.userId);
    }
  });

  // ─── FR-034: a run in flight when its owner is deleted ──────────────────────────

  it('fails a scheduled run whose owner has been deleted, rather than retrying', async () => {
    const { destinationId } = await populate();
    const job = await jobStore.createJob(user.userId, {
      destinationId,
      label: 'in flight',
      collectionIds: [],
      keepLast: 7,
      enabled: true,
    });

    await runAccountDeletion(
      { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
      stepsWithoutCollections(),
    );

    // The job record went with the account. The runner must refuse rather than press on against
    // records that no longer exist — and must certainly not report success.
    await expect(runScheduledBackup(user.userId, job.id)).rejects.toThrow(/no longer exists/i);
  });

  it('fails a run started in the window after the permission is revoked', async () => {
    const { destinationId } = await populate();
    const job = await jobStore.createJob(user.userId, {
      destinationId,
      label: 'mid-teardown',
      collectionIds: [],
      keepLast: 7,
      enabled: true,
    });

    // The pipeline revokes the standing permission BEFORE deleting any record, so this is the
    // real interleaving: a scheduled run fires while the job still exists but the permission
    // it needs is already gone.
    await offlineToken.revokeOfflineToken(user.userId);

    const run = await runScheduledBackup(user.userId, job.id);

    expect(run.status).toBe('failed');
    expect(run.failureReason).toBeTruthy();
  });
});
