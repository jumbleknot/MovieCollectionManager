/**
 * BFF /bff-api/backups/jobs/{jobId} (feature 073, FR-007/FR-034).
 *
 * GET / PATCH / DELETE, scoped to the caller. A job that is not this caller's answers 404 and
 * so does one that does not exist — indistinguishable on purpose, because a 403 would confirm
 * the id names something real.
 */
import * as jobStore from '@/bff-server/backup-job-store';
import {
  withBackupRoute,
  parseJsonBody,
  jobUpdateSchema,
  firstIssue,
  json,
  problem,
  notFound,
} from '@/bff-server/backup-route-support';
import { logger } from '@/bff-server/logger';

type Params = { jobId: string };

export async function GET(req: Request, { jobId }: Params): Promise<Response> {
  return withBackupRoute(req, 'backup_job_get', async ({ userId }) => {
    const job = await jobStore.getJob(userId, jobId);
    return job ? json(job) : notFound();
  });
}

export async function PATCH(req: Request, { jobId }: Params): Promise<Response> {
  return withBackupRoute(req, 'backup_job_update', async ({ userId }) => {
    const body = await parseJsonBody(req);
    if (!body.ok) return body.response;

    const parsed = jobUpdateSchema.safeParse(body.value);
    if (!parsed.success) return problem('Invalid backup job', 400, firstIssue(parsed.error));

    const { schedule, ...rest } = parsed.data;
    // `schedule: null` CLEARS the schedule (the job becomes on-demand only); omitting it
    // preserves whatever is stored. The two must be distinguishable, or "leave the schedule
    // alone" and "remove the schedule" become the same request.
    const patch = schedule === null ? { ...rest, schedule: undefined } : { ...rest, ...(schedule ? { schedule } : {}) };

    const updated = await jobStore.updateJob(userId, jobId, patch);
    if (!updated) return notFound();
    logger.audit('backup_job_updated', { userId, jobId });
    return json(updated);
  });
}

export async function DELETE(req: Request, { jobId }: Params): Promise<Response> {
  return withBackupRoute(req, 'backup_job_delete', async ({ userId }) => {
    const deleted = await jobStore.deleteJob(userId, jobId);
    if (!deleted) return notFound();
    // The ARTIFACTS are deliberately left at the destination. They are the user's data in the
    // user's storage; deleting a job is a statement about future backups, not a licence to
    // remove past ones. Retention prunes them only while a job exists to govern it.
    logger.audit('backup_job_deleted', { userId, jobId });
    return new Response(null, { status: 204 });
  });
}
