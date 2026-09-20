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

export async function createJob(userId: string, input: JobInput): Promise<JobView> {
  assertKeepLast(input.keepLast);
  await assertOwnedDestination(userId, input.destinationId);

  const now = new Date().toISOString();
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
  // Re-checked on UPDATE, not only on create. Otherwise a job created against an owned
  // destination could be repointed at a foreign one afterwards, which is the same attack with
  // one extra step.
  if (patch.destinationId) await assertOwnedDestination(userId, patch.destinationId);

  const jobs = await getBackupJobsCollection();
  const doc = await jobs.findOneAndUpdate(
    { _id: jobId, userId },
    { $set: { ...patch, updatedAt: new Date().toISOString() } },
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
