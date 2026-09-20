/**
 * BFF /bff-api/backups/jobs/{jobId}/run — "Back up now" (feature 073, FR-012/FR-013).
 *
 * TWO GATES, answering two different questions, both before any work starts:
 *   409 — this user already has a run in flight. One at a time: two concurrent runs of a job
 *         write two artifacts and double the load on mc-service for nothing.
 *   429 — this user has started too many runs lately.
 *
 * The slot is released in `finally`, so a run that throws does not leave the user locked out
 * until the TTL expires — the TTL is the backstop for a process that DIES, not for one that
 * merely fails.
 */
import * as jobStore from '@/bff-server/backup-job-store';
import {
  acquireUserRunSlot,
  releaseUserRunSlot,
  checkBackupRunRateLimit,
  runBackup,
} from '@/bff-server/backup-runner';
import { withBackupRoute, json, problem, notFound } from '@/bff-server/backup-route-support';
import { getBackupJobsCollection } from '@/bff-server/mongo-client';
import type { BackupJob, RunSummary } from '@/types/backups';

type Params = { jobId: string };

export async function POST(req: Request, { jobId }: Params): Promise<Response> {
  return withBackupRoute(req, 'backup_run_now', async ({ userId, jwt }) => {
    const job = await jobStore.getJob(userId, jobId);
    if (!job) return notFound();

    // Rate limit BEFORE the slot: otherwise a rate-limited caller still takes and releases the
    // slot on every attempt, and a tight retry loop can keep a legitimate run out.
    await checkBackupRunRateLimit(userId);

    if (!(await acquireUserRunSlot(userId))) {
      return problem('A backup is already running', 409, 'Wait for the current backup to finish.');
    }
    try {
      const doc = (await (await getBackupJobsCollection()).findOne({ _id: jobId, userId })) as BackupJob;
      const run = await runBackup({ userId, jwt, job: doc, trigger: 'manual' });

      const summary: RunSummary = {
        runId: run._id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        collectionCount: run.collectionCounts.length,
        movieCount: run.collectionCounts.reduce((n, c) => n + c.movieCount, 0),
        artifactBytes: run.artifactBytes,
        failureReason: run.failureReason,
      };
      await jobStore.recordLastRun(userId, jobId, summary);

      // 202 even for a failed run: the REQUEST was accepted and carried out, and its outcome
      // is in the body. A 500 here would say the server malfunctioned, when what happened is
      // that a destination the user configured did not accept the write.
      return json(summary, 202);
    } finally {
      await releaseUserRunSlot(userId);
    }
  });
}
