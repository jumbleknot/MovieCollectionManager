/**
 * BFF /bff-api/backups/jobs/{jobId}/runs — run history (feature 073, FR-014, US6).
 *
 * Defined in the OpenAPI contract and missing from the plan's file tree, which made it the
 * easiest route in the feature to skip.
 *
 * Reads the run COLLECTION rather than the job's denormalised `lastRun`: the copy on the job
 * exists so the list view is one query, and it only ever holds the newest outcome.
 */
import * as jobStore from '@/bff-server/backup-job-store';
import * as runStore from '@/bff-server/backup-run-store';
import { withBackupRoute, json, notFound } from '@/bff-server/backup-route-support';
import type { RunSummary } from '@/types/backups';

type Params = { jobId: string };

export async function GET(req: Request, { jobId }: Params): Promise<Response> {
  return withBackupRoute(req, 'backup_run_list', async ({ userId }) => {
    // Ownership is established on the JOB first, so an unknown job id answers 404 rather than
    // an empty list — an empty list would say "this job has no runs" about a job that is not
    // theirs and may not exist.
    if (!(await jobStore.getJob(userId, jobId))) return notFound();

    const runs = await runStore.listRuns(userId, jobId);
    const summaries: RunSummary[] = runs.map((run) => ({
      runId: run._id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      collectionCount: run.collectionCounts.length,
      movieCount: run.collectionCounts.reduce((n, c) => n + c.movieCount, 0),
      // Names and counts only (US6-AC4). No movie ever crosses this boundary — a run record
      // is a tally of what was backed up, never a copy of it.
      collectionCounts: run.collectionCounts,
      artifactBytes: run.artifactBytes,
      failureReason: run.failureReason,
      pruneFailureReason: run.pruneFailureReason,
    }));
    return json(summaries);
  });
}
