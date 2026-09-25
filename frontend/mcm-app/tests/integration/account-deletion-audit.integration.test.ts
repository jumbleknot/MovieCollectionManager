/**
 * The audit trail of a deletion (feature 076, T044 — FR-035, FR-036, FR-037; SC-011).
 *
 * Audit entries are the ONE thing deliberately retained about a deleted user (FR-024's single
 * exception), which makes their content the last place a leak could hide — and the only place a
 * forensic reader could look afterwards. Both halves are asserted: the events that must be
 * there, and the values that must not.
 *
 * The leak check uses the REAL secrets from the fixture, so it fails on an actual credential
 * rather than on a pattern that resembles one.
 */
import { randomUUID } from 'node:crypto';

import {
  createTestUser,
  deleteTestUser,
  type TestUser,
} from './helpers/keycloak-test-client';
import { acquireOfflineRefreshToken } from './helpers/offline-token-flow';
import {
  captureLogEntries,
  auditEntriesFor,
  findCredentialLeaks,
} from './helpers/audit-log-capture';
import { describeBackupTargets, assertBackupTargetsPresent } from './helpers/backup-targets';

import * as offlineToken from '@/bff-server/backup-offline-token';
import * as destinationStore from '@/bff-server/backup-destination-store';
import { runAccountDeletion, defaultSteps } from '@/bff-server/account-deletion';
import type { AccountDeletionSteps } from '@/bff-server/account-deletion';
import {
  getAgentConfigCollection,
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  getBackupRunsCollection,
  closeMongo,
} from '@/bff-server/mongo-client';

const S3_ENDPOINT = process.env.BACKUP_TEST_S3_ENDPOINT || 'http://localhost:9100';
const S3_BUCKET = process.env.BACKUP_TEST_S3_BUCKET || 'mcm-backups-test';
const S3_ACCESS_KEY = process.env.BACKUP_TEST_S3_ACCESS_KEY || 'mcmbackuptest';
const S3_SECRET = process.env.BACKUP_TEST_S3_SECRET_KEY || '';

jest.setTimeout(120_000);

describeBackupTargets('account deletion audit trail', () => {
  let user: TestUser;
  const prefix = `audit-${randomUUID()}`;

  beforeAll(() => assertBackupTargetsPresent());

  beforeEach(async () => {
    user = await createTestUser('t044-audit');
  });

  afterEach(async () => {
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

  function stepsWithoutCollections(count = 0): AccountDeletionSteps {
    return { ...defaultSteps, deleteCollections: async () => count };
  }

  async function seed(): Promise<string> {
    const offlineRefresh = await acquireOfflineRefreshToken(user.username, user.password);
    await offlineToken.storeOfflineToken(user.userId, offlineRefresh);
    await destinationStore.createDestination(user.userId, {
      type: 's3',
      label: `audit-${randomUUID()}`,
      endpoint: S3_ENDPOINT,
      bucket: S3_BUCKET,
      region: 'us-east-1',
      pathStyle: true,
      accessKeyId: S3_ACCESS_KEY,
      basePath: `${prefix}/${user.userId}`,
      secret: S3_SECRET,
    });
    return offlineRefresh;
  }

  it('records a completion carrying the account, and the collection count', async () => {
    await seed();

    const entries = await captureLogEntries(async () => {
      await runAccountDeletion(
        { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
        stepsWithoutCollections(3),
      );
    });

    const completed = auditEntriesFor(entries, 'account_deletion_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ userId: user.userId, collectionsDeleted: 3 });
  });

  it('records a failure naming the step, and NO completion', async () => {
    await seed();

    const entries = await captureLogEntries(async () => {
      await runAccountDeletion(
        { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
        {
          ...stepsWithoutCollections(),
          removeAgentConfig: async () => {
            throw new Error('mongo blip');
          },
        },
      ).catch(() => undefined);
    });

    const failed = auditEntriesFor(entries, 'account_deletion_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ userId: user.userId, step: 'removeAgentConfig' });
    // FR-028: a failure must never also look like a success in the trail.
    expect(auditEntriesFor(entries, 'account_deletion_completed')).toHaveLength(0);
  });

  it('leaks no credential, token or password into the trail (SC-011)', async () => {
    const offlineRefresh = await seed();

    const entries = await captureLogEntries(async () => {
      await runAccountDeletion(
        { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
        stepsWithoutCollections(),
      );
    });

    // The REAL secrets from this fixture, not a pattern that resembles one.
    const leaks = findCredentialLeaks(entries, [
      offlineRefresh,
      user.password,
      S3_SECRET,
      S3_ACCESS_KEY,
    ]);
    expect(leaks).toEqual([]);
  });

  it('does not record the user email or username — only the opaque id', async () => {
    await seed();
    const { username } = user;

    const entries = await captureLogEntries(async () => {
      await runAccountDeletion(
        { userId: user.userId, accessToken: 'unused', refreshToken: 'unused' },
        stepsWithoutCollections(),
      );
    });

    // FR-037 forbids "the user's personal details". The Keycloak id is an opaque identifier and
    // is required by FR-036; the username is not, and is what a deleted user asked us to forget.
    const ours = entries.filter((e) => String(e.action).startsWith('account_deletion'));
    expect(findCredentialLeaks(ours, [username])).toEqual([]);
  });
});
