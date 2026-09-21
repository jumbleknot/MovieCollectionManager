// Backup job persistence (feature 073, FR-007/FR-034).
//
// The job is the feature's central entity: what to back up, where, how often, how many to keep.
//
// TWO RULES LIVE HERE, both for the same reason as in the destination store — a control beats a
// convention:
//
//   1. `userId` is ALWAYS a caller argument and every query filters on it, so a foreign job is
//      indistinguishable from a missing one and the routes' 404-never-403 behaviour follows
//      without a handler having to remember it.
//
//   2. `destinationId` is verified to belong to the SAME CALLER, on create and on update. Not
//      trusted from the body. Without this a user could aim a job at another user's
//      destination and have this server write their whole collection into storage they do not
//      control — using the other user's stored credential.

import { randomUUID } from 'node:crypto';

import { getBackupDestinationsCollection, getBackupJobsCollection } from '@/bff-server/mongo-client';
import { assertValidSchedule, computeNextRun } from '@/bff-server/backup-schedule';
import type { BackupJob, RunSummary, Schedule } from '@/types/backups';

export class BackupJobInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupJobInputError';
  }
}

export interface JobInput {
  destinationId: string;
  label: string;
  collectionIds: string[];
  keepLast: number;
  enabled: boolean;
  schedule?: Schedule;
}

export type JobPatch = Partial<JobInput>;

export type JobView = Omit<BackupJob, '_id' | 'userId'> & { id: string };

const KEEP_LAST_MIN = 1;
const KEEP_LAST_MAX = 365;

function toView(doc: BackupJob): JobView {
  const { _id, userId: _userId, ...rest } = doc;
  void _userId;
  return { id: _id, ...rest };
}

function assertKeepLast(keepLast: number | undefined): void {
  if (keepLast === undefined) return;
  if (!Number.isInteger(keepLast) || keepLast < KEEP_LAST_MIN || keepLast > KEEP_LAST_MAX) {
    throw new BackupJobInputError(
      `Keep the last N backups must be a whole number between ${KEEP_LAST_MIN} and ${KEEP_LAST_MAX}`,
    );
  }
}

/**
 * Verify the destination exists AND belongs to this caller.
 *
 * The filter carries the userId, so "someone else's destination" and "no such destination"
 * produce the identical error — a job form must not become a way to discover which destination
 * ids exist.
 */
async function assertOwnedDestination(userId: string, destinationId: string): Promise<void> {
  const destinations = await getBackupDestinationsCollection();
  const found = await destinations.findOne({ _id: destinationId, userId }, { projection: { _id: 1 } });
  if (!found) throw new BackupJobInputError('That destination does not exist');
}


// ─── The atomic claim (FR-018, FR-020) ────────────────────────────────────────
//
// THIS IS THE EXACTLY-ONCE GUARANTEE, and it is the whole of it. The BFF's Mongo is a
// STANDALONE instance: there is no replica set and therefore no multi-document transaction
// available to tie a job to its run record. What is available is that a single
// `findOneAndUpdate` on one document is atomic, so the claim is expressed entirely within one
// document and nothing about it spans two.
//
// The Redis leader lock that sits in front of the tick is NOT part of this. Its safety rests on
// a TTL — a guess at how long a run can take — and an overrunning run legitimately loses it to
// another instance. That is fine, because the claim below has no timing assumption in it at
// all: whichever instances are live, each due job is handed to exactly one of them.

/**
 * How long a claim stands before another instance may take the job.
 *
 * Matched to the run slot's TTL in `backup-runner`, and it exists for the same reason: a run
 * can die without releasing — process killed, container restarted, host rebooted. WITHOUT a
 * reclaim window that job is wedged permanently, every future tick skips it, the user's backups
 * simply stop, and the only repair is someone editing the database by hand.
 *
 * Erring long is the safe direction. Too short double-fires a slow-but-healthy run, which is
 * the failure this mechanism exists to prevent; too long merely delays recovery from a crash.
 */
export const CLAIM_RECLAIM_AFTER_MS = 30 * 60 * 1000;

/**
 * Due, enabled and not already being run: `{ nextRunAt: { $type: 'string', $lte: now } }`.
 *
 * THE `$type` IS LOad-BEARING, not defensive noise. MongoDB compares across BSON types by a
 * fixed type ordering in which null sorts BEFORE every string, so a bare `$lte: '<iso>'` also
 * matches a document whose `nextRunAt` is null or missing. That is every on-demand-only job in
 * the collection, and they would all read as permanently due — a job the user never scheduled
 * would run on the first tick and then on every tick after it.
 */
const dueFilter = (nowIso: string) => ({
  enabled: true,
  nextRunAt: { $type: 'string' as const, $lte: nowIso },
});

/**
 * The candidate jobs a tick should try to claim. Reading is not claiming: two instances can
 * both see the same job here and only one of them will win `claimDueJob`.
 */
export async function findDueJobs(now: Date, limit = 100): Promise<BackupJob[]> {
  const jobs = await getBackupJobsCollection();
  return jobs.find(dueFilter(now.toISOString())).sort({ nextRunAt: 1 }).limit(limit).toArray();
}

/**
 * Take the job, atomically. Returns the document to exactly one caller; everyone else gets
 * `null`, which is a NORMAL outcome and not an error.
 *
 * A job whose time passed while the system was down is claimed ONCE on recovery, not once per
 * missed occurrence (FR-020) — the filter asks only whether `nextRunAt` is in the past, and the
 * claim that succeeds moves it forward, so the missed occurrences were never enumerated and
 * cannot each produce a run.
 */
export async function claimDueJob(
  jobId: string,
  now: Date,
  reclaimAfterMs: number = CLAIM_RECLAIM_AFTER_MS,
): Promise<BackupJob | null> {
  const nowIso = now.toISOString();
  const reclaimBefore = new Date(now.getTime() - reclaimAfterMs).toISOString();
  const jobs = await getBackupJobsCollection();
  return jobs.findOneAndUpdate(
    {
      _id: jobId,
      ...dueFilter(nowIso),
      // The `$or` is what stops an instance killed mid-run wedging its job for ever.
      $or: [{ claimedAt: null }, { claimedAt: { $lt: reclaimBefore } }],
    },
    { $set: { claimedAt: nowIso } },
    { returnDocument: 'after' },
  );
}

/**
 * Give the job back and record when it is next due, in ONE write.
 *
 * One write rather than two because there is no transaction to make two of them atomic: a
 * process dying between "clear the claim" and "set the next run" would leave the job
 * immediately due and unclaimed, and it would run again at once.
 *
 * A `null` next run means the job has no schedule any more; the field is removed rather than
 * set to null so the `$type: 'string'` filter above keeps its meaning.
 */
export async function releaseClaim(jobId: string, nextRunAt: string | null): Promise<void> {
  const jobs = await getBackupJobsCollection();
  await jobs.updateOne(
    { _id: jobId },
    nextRunAt === null
      ? { $set: { claimedAt: null, updatedAt: new Date().toISOString() }, $unset: { nextRunAt: '' } }
      : { $set: { claimedAt: null, nextRunAt, updatedAt: new Date().toISOString() } },
  );
}

/**
 * When this job should next run, given what it now looks like.
 *
 * `null` for a job with no schedule AND for a disabled one. A disabled job keeping a stale
 * `nextRunAt` would be claimable the moment someone re-enabled it, firing immediately for an
 * occurrence that passed while it was off — the user disables a job for a fortnight, turns it
 * back on, and gets an unexpected run on the spot.
 */
function nextRunFor(schedule: Schedule | undefined, enabled: boolean, from: Date): string | null {
  if (!schedule || !enabled) return null;
  return computeNextRun(schedule, from);
}

export async function createJob(userId: string, input: JobInput): Promise<JobView> {
  assertKeepLast(input.keepLast);
  if (input.schedule) assertValidSchedule(input.schedule);
  await assertOwnedDestination(userId, input.destinationId);

  const createdAt = new Date();
  const now = createdAt.toISOString();
  const nextRunAt = nextRunFor(input.schedule, input.enabled, createdAt);
  const doc: BackupJob = {
    _id: randomUUID(),
    userId,
    destinationId: input.destinationId,
    label: input.label,
    // Stored exactly as given. An EMPTY list means "every collection the user owns at RUN
    // time" and is deliberately not expanded here: expanding it would freeze the meaning to
    // whatever existed at save time, and a collection created tomorrow would never be backed
    // up with nothing in the UI to show why.
    collectionIds: input.collectionIds,
    keepLast: input.keepLast,
    enabled: input.enabled,
    ...(input.schedule ? { schedule: input.schedule } : {}),
    // Computed on SAVE, not on the first tick. A job whose `nextRunAt` were only filled in by
    // the scheduler would be invisible to the tick's index query and so would never get one.
    ...(nextRunAt ? { nextRunAt } : {}),
    claimedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await (await getBackupJobsCollection()).insertOne(doc);
  return toView(doc);
}

export async function listJobs(userId: string): Promise<JobView[]> {
  const jobs = await getBackupJobsCollection();
  const docs = await jobs.find({ userId }).sort({ label: 1 }).toArray();
  return docs.map(toView);
}

export async function getJob(userId: string, jobId: string): Promise<JobView | null> {
  const jobs = await getBackupJobsCollection();
  const doc = await jobs.findOne({ _id: jobId, userId });
  return doc ? toView(doc) : null;
}

export async function updateJob(
  userId: string,
  jobId: string,
  patch: JobPatch,
): Promise<JobView | null> {
  assertKeepLast(patch.keepLast);
  if (patch.schedule) assertValidSchedule(patch.schedule);
  // Re-checked on UPDATE, not only on create. Otherwise a job created against an owned
  // destination could be repointed at a foreign one afterwards, which is the same attack with
  // one extra step.
  if (patch.destinationId) await assertOwnedDestination(userId, patch.destinationId);

  const jobs = await getBackupJobsCollection();
  const existing = await jobs.findOne({ _id: jobId, userId });
  if (!existing) return null;

  // RECOMPUTED FROM THE MERGED JOB, not from the patch. A patch that only flips `enabled` still
  // changes when the job is next due, and one that only changes the schedule does too — reading
  // either field from the patch alone gets the other one wrong.
  const schedule = 'schedule' in patch ? (patch.schedule ?? undefined) : existing.schedule;
  const enabled = patch.enabled ?? existing.enabled;
  const nextRunAt = nextRunFor(schedule, enabled, new Date());

  const set: Record<string, unknown> = { ...patch, updatedAt: new Date().toISOString() };
  // `schedule: null` means "remove the schedule"; it must not be stored as a null schedule,
  // which would reach the arithmetic as an invalid one on the next save.
  if ('schedule' in patch && !patch.schedule) delete set.schedule;
  if (nextRunAt) set.nextRunAt = nextRunAt;

  const unset: Record<string, ''> = {};
  if ('schedule' in patch && !patch.schedule) unset.schedule = '';
  if (!nextRunAt) unset.nextRunAt = '';

  const doc = await jobs.findOneAndUpdate(
    { _id: jobId, userId },
    Object.keys(unset).length > 0 ? { $set: set, $unset: unset } : { $set: set },
    { returnDocument: 'after' },
  );
  return doc ? toView(doc) : null;
}

export async function deleteJob(userId: string, jobId: string): Promise<boolean> {
  const jobs = await getBackupJobsCollection();
  const result = await jobs.deleteOne({ _id: jobId, userId });
  return result.deletedCount === 1;
}

/**
 * Copy the newest run's summary onto the job.
 *
 * DENORMALISED on purpose: the list view shows every job with its last outcome, and without
 * this that is one query per job. The copy can lag the run collection by the moment between
 * two writes — there is no transaction available on a standalone Mongo — and when they
 * disagree the run collection is authoritative.
 *
 * A FAILED run is recorded here just as prominently as a successful one. A failure the user
 * cannot see is a failure twice: once when the backup did not happen, and again when they find
 * out at restore.
 */
export async function recordLastRun(
  userId: string,
  jobId: string,
  lastRun: RunSummary,
): Promise<void> {
  const jobs = await getBackupJobsCollection();
  await jobs.updateOne(
    { _id: jobId, userId },
    { $set: { lastRun, updatedAt: new Date().toISOString() } },
  );
}
