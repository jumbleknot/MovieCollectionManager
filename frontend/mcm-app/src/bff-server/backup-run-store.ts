// Run history (feature 073, FR-014; data-model.md "backup_runs").
//
// Run records are INDEPENDENT DOCUMENTS, not sub-documents of a job, and that is forced rather
// than chosen: the BFF's Mongo is standalone, so nothing can tie a run record to its job
// atomically. The job carries a DENORMALISED copy of the newest run (`lastRun`) so the list
// view is one query; the two can disagree for the moment between two writes, and the run
// collection is the one that is authoritative.

import { randomUUID } from 'node:crypto';

import { getBackupRunsCollection, RUN_HISTORY_TTL_MS } from '@/bff-server/mongo-client';
import type { BackupCollectionCount, BackupRun, BackupRunStatus, BackupTrigger } from '@/types/backups';

export async function startRun(
  userId: string,
  jobId: string,
  trigger: BackupTrigger,
): Promise<BackupRun> {
  const run: BackupRun = {
    _id: randomUUID(),
    userId,
    jobId,
    trigger,
    status: 'running',
    startedAt: new Date().toISOString(),
    collectionCounts: [],
    // A real BSON Date, because MongoDB's TTL monitor ignores string fields — see the index
    // comment in mongo-client.ts. Set at creation so a run that never finishes still expires.
    expiresAt: new Date(Date.now() + RUN_HISTORY_TTL_MS),
  };
  await (await getBackupRunsCollection()).insertOne(run);
  return run;
}

export async function finishRun(
  runId: string,
  patch: {
    status: BackupRunStatus;
    artifactKey?: string;
    artifactBytes?: number;
    collectionCounts?: BackupCollectionCount[];
    failureReason?: string;
    prunedCount?: number;
    pruneFailureReason?: string;
  },
): Promise<BackupRun | null> {
  const collection = await getBackupRunsCollection();
  return collection.findOneAndUpdate(
    { _id: runId },
    { $set: { ...patch, finishedAt: new Date().toISOString() } },
    { returnDocument: 'after' },
  );
}

/** Newest first — a user looking at run history wants the most recent outcome, not the oldest. */
export async function listRuns(userId: string, jobId: string, limit = 50): Promise<BackupRun[]> {
  const collection = await getBackupRunsCollection();
  return collection.find({ userId, jobId }).sort({ startedAt: -1 }).limit(limit).toArray();
}

export async function getRun(userId: string, runId: string): Promise<BackupRun | null> {
  const collection = await getBackupRunsCollection();
  return (await getBackupRunsCollection()).findOne({ _id: runId, userId }) ?? (void collection, null);
}
