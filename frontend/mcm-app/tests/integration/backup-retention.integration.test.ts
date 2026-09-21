/**
 * Retention — keep the last N, and never let a failure cost a good version (feature 073, T062 —
 * FR-025/026/027; SC-007, SC-008; US5-AC1..AC5).
 *
 * THE CASE THAT MATTERS IS THE SECOND ONE. Keeping exactly N after a success is the feature;
 * pruning NOTHING after a failure is the safety property. A retention bug that fires on the
 * failure path deletes the user's good backups at precisely the moment the new one did not get
 * written — it converts "today's backup failed" into "yesterday's backup is gone too", and the
 * user finds out at restore.
 *
 * AGAINST REAL MinIO. Retention is "list the keys, sort them, delete the tail", and every part
 * of that is a property of the destination: what `list` returns for a prefix, whether the order
 * is really lexicographic, whether a delete of a missing key errors. A mock would be me
 * asserting my own assumptions about someone else's server.
 */
import { randomUUID } from 'node:crypto';

import {
  describeBackupTargets,
  assertBackupTargetsPresent,
} from './helpers/backup-targets';

import * as retention from '@/bff-server/backup-retention';
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import type { BackupDestinationDriver } from '@/bff-server/backup-destination-driver';
import type { S3BackupDestination } from '@/types/backups';

const S3_ENDPOINT = process.env.BACKUP_TEST_S3_ENDPOINT || 'http://localhost:9100';
const S3_BUCKET = process.env.BACKUP_TEST_S3_BUCKET || 'mcm-backups-test';
const S3_ACCESS_KEY = process.env.BACKUP_TEST_S3_ACCESS_KEY || 'mcmbackuptest';
const S3_SECRET = process.env.BACKUP_TEST_S3_SECRET_KEY || '';

jest.setTimeout(60_000);

describeBackupTargets('backup retention', () => {
  // A unique prefix per run so a re-run never sees the last one's objects, and two overlapping
  // runs cannot delete each other's fixtures.
  const basePath = `ret-${randomUUID()}`;
  const JOB = 'job-aaaa';
  const OTHER_JOB = 'job-bbbb';

  let driver: BackupDestinationDriver;

  const destination = (): S3BackupDestination => ({
    _id: 'dest-retention',
    userId: 'user-retention',
    type: 's3',
    label: 'retention target',
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    region: 'us-east-1',
    pathStyle: true,
    accessKeyId: S3_ACCESS_KEY,
    basePath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    assertBackupTargetsPresent();
    driver = await createBackupDriver(destination(), S3_SECRET);
  });

  const keyFor = (job: string, iso: string) => `${basePath}/${job}/${iso}.json.gz`;

  /** Put N artifacts for `job`, oldest first, and return their keys in that order. */
  async function seedVersions(job: string, isos: string[]): Promise<string[]> {
    const keys = isos.map((iso) => keyFor(job, iso));
    for (const key of keys) {
      await driver.put(key, Buffer.from(`artifact ${key}`), 'application/gzip');
    }
    return keys;
  }

  const listJob = async (job: string) =>
    (await driver.list(`${basePath}/${job}/`)).map((o) => o.key).sort();

  afterEach(async () => {
    for (const job of [JOB, OTHER_JOB]) {
      for (const key of await listJob(job)) await driver.delete(key).catch(() => undefined);
    }
  });

  const FOUR = [
    '2026-06-01T03:00:00.000Z',
    '2026-06-02T03:00:00.000Z',
    '2026-06-03T03:00:00.000Z',
    '2026-06-04T03:00:00.000Z',
  ];

  describe('after a SUCCESSFUL run', () => {
    it('keeps exactly N and removes the OLDEST (SC-007)', async () => {
      await seedVersions(JOB, FOUR);

      const outcome = await retention.pruneOldVersions(driver, destination(), JOB, 3);

      expect(outcome.prunedCount).toBe(1);
      expect(outcome.failureReason).toBeUndefined();
      const remaining = await listJob(JOB);
      expect(remaining).toHaveLength(3);
      // The one that went is the oldest, and the three newest are intact. Asserting the COUNT
      // alone would pass an implementation that deleted the newest — the opposite of retention.
      expect(remaining).not.toContain(keyFor(JOB, FOUR[0]));
      expect(remaining).toEqual([1, 2, 3].map((i) => keyFor(JOB, FOUR[i])).sort());
    });

    it('does nothing when there are fewer versions than the limit', async () => {
      await seedVersions(JOB, FOUR.slice(0, 2));

      const outcome = await retention.pruneOldVersions(driver, destination(), JOB, 3);

      expect(outcome.prunedCount).toBe(0);
      expect(await listJob(JOB)).toHaveLength(2);
    });

    it('applies a LOWERED retention count on the next run (US5-AC4)', async () => {
      await seedVersions(JOB, FOUR);

      // The user dropped keep-last from 7 to 1 after these four were written.
      const outcome = await retention.pruneOldVersions(driver, destination(), JOB, 1);

      expect(outcome.prunedCount).toBe(3);
      expect(await listJob(JOB)).toEqual([keyFor(JOB, FOUR[3])]);
    });

    it('never considers another job\'s artifacts, or files the user put there (US5-AC5)', async () => {
      await seedVersions(JOB, FOUR);
      await seedVersions(OTHER_JOB, FOUR);
      // Something the user keeps at the same destination that this system did not write.
      const foreign = `${basePath}/${JOB}/holiday-photos.zip`;
      await driver.put(foreign, Buffer.from('not ours'), 'application/zip');

      await retention.pruneOldVersions(driver, destination(), JOB, 1);

      // The other job is untouched — all four still there.
      expect(await listJob(OTHER_JOB)).toHaveLength(4);
      // And the foreign object survives even though it sits under this job's own prefix.
      // Deleting it would be destroying data the user stored, not cleaning up after ourselves.
      expect(await listJob(JOB)).toContain(foreign);

      await driver.delete(foreign);
    });
  });

  describe('after a FAILED run (SC-008)', () => {
    it('prunes NOTHING — a failed run must never cost a good version', async () => {
      await seedVersions(JOB, FOUR);

      // The runner's contract: pruning is reached only on success. This asserts the decision
      // itself rather than the caller's discipline, so a future caller cannot get it wrong.
      const outcome = await retention.pruneAfterRun(driver, destination(), JOB, 3, 'failed');

      expect(outcome.prunedCount).toBe(0);
      expect(await listJob(JOB)).toHaveLength(4);
    });

    it('prunes on success through the same entry point', async () => {
      // The positive control for the case above: without it, "pruned nothing" would also be
      // satisfied by an entry point that never prunes at all.
      await seedVersions(JOB, FOUR);

      const outcome = await retention.pruneAfterRun(driver, destination(), JOB, 3, 'success');

      expect(outcome.prunedCount).toBe(1);
      expect(await listJob(JOB)).toHaveLength(3);
    });

    it('prunes nothing for a PARTIAL run either', async () => {
      await seedVersions(JOB, FOUR);

      const outcome = await retention.pruneAfterRun(driver, destination(), JOB, 3, 'partial');

      expect(outcome.prunedCount).toBe(0);
      expect(await listJob(JOB)).toHaveLength(4);
    });
  });

  describe('when a delete at the destination fails (FR-027)', () => {
    it('reports the failure separately and does not claim the run failed', async () => {
      await seedVersions(JOB, FOUR);
      // A driver whose delete refuses, everything else real.
      const refusing: BackupDestinationDriver = {
        ...driver,
        list: (prefix, pageSize) => driver.list(prefix, pageSize),
        delete: async () => {
          throw new Error('S3 DELETE failed: HTTP 403');
        },
      };

      const outcome = await retention.pruneOldVersions(refusing, destination(), JOB, 1);

      // A pruning failure has not cost the user the backup that was just written, so it is
      // reported on its own rather than turned into a failed run.
      expect(outcome.prunedCount).toBe(0);
      expect(outcome.failureReason).toBeTruthy();
      // Safe text only: a constructed driver message, never an upstream body.
      expect(outcome.failureReason).toMatch(/^Some older backups could not be removed/);
      expect(await listJob(JOB)).toHaveLength(4);
    });

    it('retries on the next successful run, with no retry state to remember', async () => {
      await seedVersions(JOB, FOUR);
      const refusing: BackupDestinationDriver = {
        ...driver,
        delete: async () => {
          throw new Error('S3 DELETE failed: HTTP 403');
        },
      };
      await retention.pruneOldVersions(refusing, destination(), JOB, 1);
      expect(await listJob(JOB)).toHaveLength(4);

      // The next run, with the destination healthy again. Nothing recorded that a prune was
      // owed — it falls out of listing and sorting, which is why there is no retry state.
      const outcome = await retention.pruneOldVersions(driver, destination(), JOB, 1);

      expect(outcome.prunedCount).toBe(3);
      expect(await listJob(JOB)).toHaveLength(1);
    });

    it('keeps deleting the rest when ONE delete fails', async () => {
      await seedVersions(JOB, FOUR);
      let calls = 0;
      const flaky: BackupDestinationDriver = {
        ...driver,
        delete: async (key: string) => {
          calls += 1;
          if (calls === 1) throw new Error('S3 DELETE failed: HTTP 500');
          return driver.delete(key);
        },
      };

      const outcome = await retention.pruneOldVersions(flaky, destination(), JOB, 1);

      // Two of the three deletions succeeded. Abandoning the whole prune on the first error
      // would let a destination fill up because of one transient failure.
      expect(outcome.prunedCount).toBe(2);
      expect(outcome.failureReason).toBeTruthy();
      expect(await listJob(JOB)).toHaveLength(2);
    });
  });
});
