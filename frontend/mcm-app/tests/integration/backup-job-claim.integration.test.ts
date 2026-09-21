/**
 * The atomic claim — exactly once, without transactions (feature 073, T050 — FR-018; US4-AC4).
 *
 * THE BFF'S MONGO IS STANDALONE. There is no replica set, so there are no multi-document
 * transactions available here at all. The single `findOneAndUpdate` this suite exercises is not
 * an optimisation over a transaction — it IS the correctness mechanism, and the Redis leader
 * lock next to it is only an optimisation with a TTL guess inside it. If this suite is wrong,
 * a scheduled job double-fires and the user gets two artifacts with no explanation.
 *
 * CLAIMS ARE ISSUED CONCURRENTLY, VIA `Promise.all`. A sequential loop proves nothing about a
 * race: the first call completes before the second begins, so even a read-then-write
 * implementation with no atomicity whatsoever passes it. Every assertion here that matters
 * depends on the calls genuinely overlapping.
 *
 * AGAINST REAL MONGO. The property under test — that exactly one of N overlapping
 * `findOneAndUpdate` calls matches the filter — is a database behaviour. Asserting it against a
 * mock would assert only that the mock was written to agree with the expectation.
 */
import { randomUUID } from 'node:crypto';

import * as destinationStore from '@/bff-server/backup-destination-store';
import * as jobStore from '@/bff-server/backup-job-store';
import {
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  getBackupRunsCollection,
  closeMongo,
} from '@/bff-server/mongo-client';

const USER = `t050-${randomUUID()}`;
let destinationId: string;

beforeAll(async () => {
  destinationId = (
    await destinationStore.createDestination(USER, {
      type: 's3',
      label: `claim-${randomUUID()}`,
      endpoint: 'https://s3.example.com',
      bucket: 'backups',
      region: 'us-east-1',
      pathStyle: true,
      accessKeyId: 'AKIDEXAMPLE',
      secret: 'the-secret',
    })
  ).id;
});

afterAll(async () => {
  await (await getBackupDestinationsCollection()).deleteMany({ userId: USER });
  await (await getBackupJobsCollection()).deleteMany({ userId: USER });
  await (await getBackupRunsCollection()).deleteMany({ userId: USER });
  await closeMongo();
});

const NOW = new Date('2026-06-15T03:00:00.000Z');
const DUE = '2026-06-15T03:00:00.000Z';

/** A job that is due at `NOW`, created directly so `nextRunAt` and `claimedAt` are exact. */
async function makeDueJob(
  overrides: { enabled?: boolean; nextRunAt?: string | undefined; claimedAt?: string | null } = {},
): Promise<string> {
  const job = await jobStore.createJob(USER, {
    destinationId,
    label: `job-${randomUUID().slice(0, 8)}`,
    collectionIds: [],
    keepLast: 7,
    enabled: overrides.enabled ?? true,
  });
  await (await getBackupJobsCollection()).updateOne(
    { _id: job.id },
    {
      $set: {
        nextRunAt: 'nextRunAt' in overrides ? overrides.nextRunAt : DUE,
        claimedAt: overrides.claimedAt ?? null,
      },
    },
  );
  return job.id;
}

describe('exactly one concurrent caller claims a due job', () => {
  it('gives the document to exactly one of eight genuinely concurrent claims', async () => {
    const jobId = await makeDueJob();

    // Promise.all, NOT a loop. The calls must overlap for this to be a test of anything.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => jobStore.claimDueJob(jobId, NOW)),
    );

    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    expect(winners[0]!._id).toBe(jobId);
  });

  it('marks the job claimed so a later tick sees a run in flight', async () => {
    const jobId = await makeDueJob();
    await jobStore.claimDueJob(jobId, NOW);

    const stored = await (await getBackupJobsCollection()).findOne({ _id: jobId });
    expect(stored?.claimedAt).toBe(NOW.toISOString());
  });

  it('holds across several independent due jobs claimed at once', async () => {
    // Three jobs, eight claimants each, all overlapping. Each job must go to exactly one
    // claimant — a filter that accidentally matched on something other than `_id` would show
    // up here as a job claimed twice or a job never claimed at all.
    const jobIds = await Promise.all([makeDueJob(), makeDueJob(), makeDueJob()]);
    const attempts = jobIds.flatMap((jobId) =>
      Array.from({ length: 8 }, () => jobStore.claimDueJob(jobId, NOW)),
    );

    const results = await Promise.all(attempts);

    const claimedIds = results.filter((r) => r !== null).map((r) => r!._id).sort();
    expect(claimedIds).toEqual([...jobIds].sort());
  });
});

describe('reclaiming a job whose runner died', () => {
  it('reclaims a job claimed longer ago than the reclaim ceiling', async () => {
    // Without this, an instance killed mid-run wedges its job PERMANENTLY: `claimedAt` stays
    // set, every future tick skips it, and the only repair is someone editing the database.
    // The user's backups stop and nothing says why.
    const stale = new Date(NOW.getTime() - jobStore.CLAIM_RECLAIM_AFTER_MS - 60_000).toISOString();
    const jobId = await makeDueJob({ claimedAt: stale });

    const claimed = await jobStore.claimDueJob(jobId, NOW);

    expect(claimed).not.toBeNull();
    expect(claimed!._id).toBe(jobId);
  });

  it('refuses a job claimed more recently than the reclaim ceiling', async () => {
    // The other half of the same rule. Reclaiming too eagerly is the double-fire this whole
    // mechanism exists to prevent, so the boundary is asserted from both sides.
    const recent = new Date(NOW.getTime() - 60_000).toISOString();
    const jobId = await makeDueJob({ claimedAt: recent });

    expect(await jobStore.claimDueJob(jobId, NOW)).toBeNull();
  });

  it('still gives a reclaimable job to exactly one of eight concurrent claims', async () => {
    // Reclaim is the path where two instances are most likely to collide — the first tick
    // after a restart, when several instances all see the same abandoned job at once.
    const stale = new Date(NOW.getTime() - jobStore.CLAIM_RECLAIM_AFTER_MS - 60_000).toISOString();
    const jobId = await makeDueJob({ claimedAt: stale });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => jobStore.claimDueJob(jobId, NOW)),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe('what is never claimed', () => {
  it('never claims a disabled job', async () => {
    const jobId = await makeDueJob({ enabled: false });
    expect(await jobStore.claimDueJob(jobId, NOW)).toBeNull();
  });

  it('never claims a job that is not yet due', async () => {
    const jobId = await makeDueJob({ nextRunAt: '2026-06-15T03:00:00.001Z' });
    expect(await jobStore.claimDueJob(jobId, NOW)).toBeNull();
  });

  it('never claims a job with no schedule at all', async () => {
    // An on-demand-only job has no `nextRunAt`. A filter using `$lte` against a missing field
    // does not match, but that is worth pinning: an implementation that defaulted the field to
    // the epoch would make every manual-only job due for ever.
    const jobId = await makeDueJob({ nextRunAt: undefined });
    expect(await jobStore.claimDueJob(jobId, NOW)).toBeNull();
  });

  it('claims a job that came due while the system was down, exactly once', async () => {
    // FR-020. `nextRunAt` is long past — several occurrences were missed — and the job must
    // still yield ONE claim, not one per missed occurrence.
    const jobId = await makeDueJob({ nextRunAt: '2026-06-01T03:00:00.000Z' });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => jobStore.claimDueJob(jobId, NOW)),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe('finding what is due, and releasing afterwards', () => {
  it('lists only enabled jobs whose next run has arrived', async () => {
    const due = await makeDueJob();
    const notDue = await makeDueJob({ nextRunAt: '2027-01-01T00:00:00.000Z' });
    const disabled = await makeDueJob({ enabled: false });

    const found = (await jobStore.findDueJobs(NOW)).map((j) => j._id);

    expect(found).toContain(due);
    expect(found).not.toContain(notDue);
    expect(found).not.toContain(disabled);
  });

  it('releases the claim and records the next occurrence in one write', async () => {
    const jobId = await makeDueJob();
    await jobStore.claimDueJob(jobId, NOW);

    await jobStore.releaseClaim(jobId, '2026-06-16T03:00:00.000Z');

    const stored = await (await getBackupJobsCollection()).findOne({ _id: jobId });
    expect(stored?.claimedAt).toBeNull();
    expect(stored?.nextRunAt).toBe('2026-06-16T03:00:00.000Z');
  });

  it('a released job is immediately claimable again once its new time arrives', async () => {
    const jobId = await makeDueJob();
    await jobStore.claimDueJob(jobId, NOW);
    await jobStore.releaseClaim(jobId, '2026-06-16T03:00:00.000Z');

    expect(await jobStore.claimDueJob(jobId, NOW)).toBeNull();
    expect(await jobStore.claimDueJob(jobId, new Date('2026-06-16T03:00:00.000Z'))).not.toBeNull();
  });
});
