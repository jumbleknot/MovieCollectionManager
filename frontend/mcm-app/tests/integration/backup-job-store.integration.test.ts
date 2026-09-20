/**
 * Backup job store (feature 073, T036 — FR-007/FR-034; US2-AC1, US6-AC1).
 *
 * The job is this feature's central entity and had no test of its own until this one.
 *
 * AGAINST REAL Mongo, for the same reason the destination store is: the properties asserted
 * here — ownership filtering, a partial update preserving what it is not told about, a
 * denormalised copy staying in step — are Mongo behaviours, not logic I could meaningfully
 * assert against a mock I also wrote.
 */
import { randomUUID } from 'node:crypto';

import * as destinationStore from '@/bff-server/backup-destination-store';
import * as jobStore from '@/bff-server/backup-job-store';
import * as runStore from '@/bff-server/backup-run-store';
import {
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  getBackupRunsCollection,
  closeMongo,
} from '@/bff-server/mongo-client';

const USER_A = `t036-a-${randomUUID()}`;
const USER_B = `t036-b-${randomUUID()}`;

let destinationA: string;
let destinationB: string;

const destinationInput = (label: string) => ({
  type: 's3' as const,
  label,
  endpoint: 'https://s3.example.com',
  bucket: 'backups',
  region: 'us-east-1',
  pathStyle: true,
  accessKeyId: 'AKIDEXAMPLE',
  secret: 'the-secret',
});

beforeAll(async () => {
  destinationA = (await destinationStore.createDestination(USER_A, destinationInput(`a-${randomUUID()}`))).id;
  destinationB = (await destinationStore.createDestination(USER_B, destinationInput(`b-${randomUUID()}`))).id;
});

afterAll(async () => {
  const users = { $in: [USER_A, USER_B] };
  await (await getBackupDestinationsCollection()).deleteMany({ userId: users });
  await (await getBackupJobsCollection()).deleteMany({ userId: users });
  await (await getBackupRunsCollection()).deleteMany({ userId: users });
  await closeMongo();
});

const jobInput = (overrides: Record<string, unknown> = {}) => ({
  destinationId: destinationA,
  label: `job-${randomUUID().slice(0, 8)}`,
  collectionIds: [] as string[],
  keepLast: 7,
  enabled: true,
  ...overrides,
});

describe('round-trip', () => {
  it('stores collectionIds, keepLast and enabled as given', async () => {
    const job = await jobStore.createJob(USER_A, jobInput({ collectionIds: ['c1', 'c2'], keepLast: 30, enabled: false }));
    const read = await jobStore.getJob(USER_A, job.id);
    expect(read?.collectionIds).toEqual(['c1', 'c2']);
    expect(read?.keepLast).toBe(30);
    expect(read?.enabled).toBe(false);
  });

  it('keeps an EMPTY collectionIds empty — "everything" is resolved at run time', async () => {
    // Expanding it to the current collection list at SAVE time would be the tempting
    // optimisation and would silently freeze the meaning of "all my collections": one created
    // tomorrow would never be backed up, and nothing in the UI would show why.
    const job = await jobStore.createJob(USER_A, jobInput({ collectionIds: [] }));
    const stored = await (await getBackupJobsCollection()).findOne({ _id: job.id });
    expect(stored?.collectionIds).toEqual([]);
  });

  it('preserves fields an update does not mention', async () => {
    const job = await jobStore.createJob(USER_A, jobInput({ collectionIds: ['c1'], keepLast: 14 }));
    await jobStore.updateJob(USER_A, job.id, { label: 'renamed' });
    const read = await jobStore.getJob(USER_A, job.id);
    expect(read?.label).toBe('renamed');
    expect(read?.collectionIds).toEqual(['c1']);
    expect(read?.keepLast).toBe(14);
  });
});

describe('validation', () => {
  it.each([0, -1, 366, 1000])('rejects keepLast of %s', async (keepLast) => {
    await expect(jobStore.createJob(USER_A, jobInput({ keepLast }))).rejects.toThrow();
  });

  it.each([1, 7, 365])('accepts keepLast of %s', async (keepLast) => {
    await expect(jobStore.createJob(USER_A, jobInput({ keepLast }))).resolves.toBeTruthy();
  });

  it('rejects a destination the CALLER does not own (FR-034)', async () => {
    // Checked against the caller's id, never trusted from the body. Otherwise a user could
    // aim a job at another user's destination and have this server write their collection
    // into storage they do not control.
    await expect(jobStore.createJob(USER_A, jobInput({ destinationId: destinationB }))).rejects.toThrow();
  });

  it('rejects a destination that does not exist at all', async () => {
    await expect(
      jobStore.createJob(USER_A, jobInput({ destinationId: '00000000-0000-4000-8000-000000000000' })),
    ).rejects.toThrow();
  });

  it('rejects repointing a job at a foreign destination on UPDATE, not only on create', async () => {
    const job = await jobStore.createJob(USER_A, jobInput());
    await expect(jobStore.updateJob(USER_A, job.id, { destinationId: destinationB })).rejects.toThrow();
  });
});

describe('scoping (FR-034)', () => {
  it('does not return, update or delete another user’s job', async () => {
    const job = await jobStore.createJob(USER_A, jobInput());
    expect(await jobStore.getJob(USER_B, job.id)).toBeNull();
    expect(await jobStore.updateJob(USER_B, job.id, { label: 'hijacked' })).toBeNull();
    expect(await jobStore.deleteJob(USER_B, job.id)).toBe(false);
    expect((await jobStore.getJob(USER_A, job.id))?.label).not.toBe('hijacked');
  });

  it('lists only the caller’s jobs', async () => {
    await jobStore.createJob(USER_A, jobInput());
    const mine = await jobStore.listJobs(USER_B);
    expect(mine.every((j) => j.destinationId !== destinationA)).toBe(true);
  });
});

describe('lastRun is a denormalised copy', () => {
  it('lets the list view read the newest outcome without a second query', async () => {
    // The job and the run record cannot be written atomically — the BFF's Mongo is standalone.
    // So `lastRun` is a copy that can briefly lag, and the run collection stays authoritative.
    const job = await jobStore.createJob(USER_A, jobInput());
    const run = await runStore.startRun(USER_A, job.id, 'manual');
    await runStore.finishRun(run._id, { status: 'success', artifactKey: 'k', collectionCounts: [] });

    await jobStore.recordLastRun(USER_A, job.id, {
      runId: run._id,
      status: 'success',
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      collectionCount: 0,
      movieCount: 0,
    });

    const listed = (await jobStore.listJobs(USER_A)).find((j) => j.id === job.id);
    expect(listed?.lastRun?.runId).toBe(run._id);
    expect(listed?.lastRun?.status).toBe('success');
  });

  it('records a FAILED run just as visibly — a failure the user cannot see is a failure twice', async () => {
    const job = await jobStore.createJob(USER_A, jobInput());
    const run = await runStore.startRun(USER_A, job.id, 'scheduled');
    await jobStore.recordLastRun(USER_A, job.id, {
      runId: run._id,
      status: 'failed',
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      collectionCount: 0,
      movieCount: 0,
      failureReason: 'That destination could not be reached',
    });
    const read = await jobStore.getJob(USER_A, job.id);
    expect(read?.lastRun?.status).toBe('failed');
    expect(read?.lastRun?.failureReason).toBeTruthy();
  });
});

describe('run history', () => {
  it('lists a job’s runs newest first, scoped to the caller', async () => {
    const job = await jobStore.createJob(USER_A, jobInput());
    const first = await runStore.startRun(USER_A, job.id, 'manual');
    await new Promise((r) => setTimeout(r, 5));
    const second = await runStore.startRun(USER_A, job.id, 'manual');

    const runs = await runStore.listRuns(USER_A, job.id);
    expect(runs.map((r) => r._id)).toEqual([second._id, first._id]);
    expect(await runStore.listRuns(USER_B, job.id)).toEqual([]);
  });
});
