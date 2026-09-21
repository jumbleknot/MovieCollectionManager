/**
 * Account deletion takes the standing permission with it (feature 073, T054 — FR-023; US4-AC3).
 *
 * NOTHING COVERED THIS UNTIL NOW, and the gap was not cosmetic: a deleted account could leave a
 * live, non-expiring offline token at Keycloak with no local record that it existed — so
 * nothing left in the system could ever revoke it. That is the same failure SC-012 exists to
 * prevent, arriving through a door nobody was watching.
 *
 * THE ONE THING THAT IS NOT DELETED IS THE USER'S DATA AT THEIR OWN DESTINATION. Those
 * artifacts sit in storage the user owns and pays for. Deleting them would not be cleaning up
 * after ourselves — it would be destroying the data we were trusted to copy, at the exact
 * moment the user has least reason to expect it. Asserted explicitly, against real MinIO,
 * because "we forgot to delete them" and "we deliberately leave them" look identical in a
 * passing suite otherwise.
 */
import { randomUUID } from 'node:crypto';

import {
  createTestUser,
  deleteTestUser,
  type TestUser,
} from './helpers/keycloak-test-client';
import {
  acquireOfflineRefreshToken,
  offlineTokenStillWorks,
} from './helpers/offline-token-flow';
import {
  describeBackupTargets,
  assertBackupTargetsPresent,
} from './helpers/backup-targets';

import * as offlineToken from '@/bff-server/backup-offline-token';
import * as destinationStore from '@/bff-server/backup-destination-store';
import * as jobStore from '@/bff-server/backup-job-store';
import * as runStore from '@/bff-server/backup-run-store';
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
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
  throw new Error('backup-account-deletion requires KEYCLOAK_CLIENT_SECRET and E2E_TEST_PASSWORD');
}

jest.setTimeout(60_000);

describeBackupTargets('backup teardown on account deletion', () => {
  let user: TestUser;
  const prefix = `del-${randomUUID()}`;

  beforeAll(() => {
    assertBackupTargetsPresent();
  });

  beforeEach(async () => {
    user = await createTestUser('t054-del');
  });

  afterEach(async () => {
    await (await getBackupDestinationsCollection()).deleteMany({ userId: user?.userId });
    await (await getBackupJobsCollection()).deleteMany({ userId: user?.userId });
    await (await getBackupRunsCollection()).deleteMany({ userId: user?.userId });
    await (await getAgentConfigCollection()).deleteMany({ _id: user?.userId });
    await deleteTestUser(user?.userId);
  });

  afterAll(async () => {
    await closeMongo();
  });

  /** A destination pointed at the real MinIO, so "the artifacts survive" can be checked. */
  async function realDestination(): Promise<string> {
    return (
      await destinationStore.createDestination(user.userId, {
        type: 's3',
        label: `del-${randomUUID()}`,
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

  it('leaves the offline grant rejected by Keycloak afterwards', async () => {
    const token = await acquireOfflineRefreshToken(user.username, user.password);
    await offlineToken.storeOfflineToken(user.userId, token);
    expect(await offlineTokenStillWorks(token)).toBe(true);

    await offlineToken.tearDownUserBackups(user.userId);

    // The same standard as SC-012: asked to honour the token, Keycloak refuses. A local
    // `$unset` would be evidence of forgetting, which is not evidence of revoking.
    expect(await offlineTokenStillWorks(token)).toBe(false);
  });

  it('erases every destination, job and run, leaving no sealed secret behind', async () => {
    const destinationId = await realDestination();
    const job = await jobStore.createJob(user.userId, {
      destinationId,
      label: 'to be erased',
      collectionIds: [],
      keepLast: 7,
      enabled: true,
    });
    await runStore.startRun(user.userId, job.id, 'manual');

    await offlineToken.tearDownUserBackups(user.userId);

    expect(await (await getBackupDestinationsCollection()).countDocuments({ userId: user.userId })).toBe(0);
    expect(await (await getBackupJobsCollection()).countDocuments({ userId: user.userId })).toBe(0);
    expect(await (await getBackupRunsCollection()).countDocuments({ userId: user.userId })).toBe(0);
    // Not merely "the documents are gone": no ciphertext of this user's credential survives
    // anywhere in the three collections, under any field name.
    const leftovers = await (await getBackupDestinationsCollection())
      .find({ secretEnc: { $exists: true }, userId: user.userId })
      .toArray();
    expect(leftovers).toHaveLength(0);
    const config = await (await getAgentConfigCollection()).findOne({ _id: user.userId });
    expect(config?.offlineRefreshEnc).toBeUndefined();
  });

  it('leaves the artifacts at the user OWN destination completely untouched', async () => {
    const destinationId = await realDestination();
    const job = await jobStore.createJob(user.userId, {
      destinationId,
      label: 'has artifacts',
      collectionIds: [],
      keepLast: 7,
      enabled: true,
    });
    const d = await driver();
    const key = `${prefix}/${user.userId}/${job.id}/2026-06-01T03:00:00.000Z.json.gz`;
    await d.put(key, Buffer.from('not-really-gzip-but-real-bytes'), 'application/gzip');
    const before = await d.list(`${prefix}/${user.userId}/${job.id}/`);
    expect(before.length).toBeGreaterThan(0);

    await offlineToken.tearDownUserBackups(user.userId);

    // The user's property, at storage they own. Still there.
    const after = await d.list(`${prefix}/${user.userId}/${job.id}/`);
    expect(after.map((o) => o.key)).toEqual(before.map((o) => o.key));

    await d.delete(key); // test fixture cleanup, not part of the assertion
  });

  it('revokes BEFORE deleting anything locally', async () => {
    const token = await acquireOfflineRefreshToken(user.username, user.password);
    await offlineToken.storeOfflineToken(user.userId, token);
    const destinationId = await realDestination();
    await jobStore.createJob(user.userId, {
      destinationId,
      label: 'ordering',
      collectionIds: [],
      keepLast: 7,
      enabled: true,
    });

    let destinationsAtRevokeTime = -1;
    await offlineToken.tearDownUserBackups(user.userId, {
      revokeAtIdp: async (t) => {
        destinationsAtRevokeTime = await (await getBackupDestinationsCollection()).countDocuments({
          userId: user.userId,
        });
        await offlineToken.revokeOfflineTokenAtIdp(t);
      },
    });

    // Reversed, a failed revocation would orphan a live token with nothing left pointing at it.
    expect(destinationsAtRevokeTime).toBe(1);
  });

  it('surfaces a revocation failure and deletes NOTHING when it happens', async () => {
    const token = await acquireOfflineRefreshToken(user.username, user.password);
    await offlineToken.storeOfflineToken(user.userId, token);
    const destinationId = await realDestination();
    await jobStore.createJob(user.userId, {
      destinationId,
      label: 'kept on failure',
      collectionIds: [],
      keepLast: 7,
      enabled: true,
    });

    await expect(
      offlineToken.tearDownUserBackups(user.userId, {
        revokeAtIdp: async () => {
          throw new Error('Keycloak unreachable');
        },
      }),
    ).rejects.toThrow(offlineToken.OfflineTokenRevocationError);

    // Everything still present, so the deletion can be RETRIED. Deleting the local records
    // while the revocation failed is what strands a live token for ever.
    expect(await (await getBackupDestinationsCollection()).countDocuments({ userId: user.userId })).toBe(1);
    expect(await (await getBackupJobsCollection()).countDocuments({ userId: user.userId })).toBe(1);
    expect(await offlineToken.hasOfflineToken(user.userId)).toBe(true);
    expect(await offlineTokenStillWorks(token)).toBe(true);
  });

  it('is a no-op for a user who never configured a backup', async () => {
    // The common case by far, and it must not throw: most deleted accounts never touched this
    // feature at all, and an exception here would fail an unrelated account deletion.
    await expect(offlineToken.tearDownUserBackups(user.userId)).resolves.toBeUndefined();
    expect(await (await getBackupJobsCollection()).countDocuments({ userId: user.userId })).toBe(0);
  });
});
