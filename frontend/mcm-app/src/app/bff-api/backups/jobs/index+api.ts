/**
 * BFF /bff-api/backups/jobs (feature 073, FR-007/FR-034).
 *
 * GET  → this caller's jobs, each with its denormalised last-run summary so the list view is
 *        one query rather than one per job.
 * POST → create. The destination is verified to belong to the CALLER by the store, not trusted
 *        from the body.
 */
import * as jobStore from '@/bff-server/backup-job-store';
import {
  withBackupRoute,
  parseJsonBody,
  jobCreateSchema,
  firstIssue,
  json,
  problem,
} from '@/bff-server/backup-route-support';
import { logger } from '@/bff-server/logger';

export async function GET(req: Request): Promise<Response> {
  return withBackupRoute(req, 'backup_job_list', async ({ userId }) =>
    json(await jobStore.listJobs(userId)),
  );
}

export async function POST(req: Request): Promise<Response> {
  return withBackupRoute(req, 'backup_job_create', async ({ userId }) => {
    const body = await parseJsonBody(req);
    if (!body.ok) return body.response;

    const parsed = jobCreateSchema.safeParse(body.value);
    if (!parsed.success) return problem('Invalid backup job', 400, firstIssue(parsed.error));

    const created = await jobStore.createJob(userId, parsed.data);
    logger.audit('backup_job_created', { userId, jobId: created.id, scheduled: Boolean(created.schedule) });
    return json(created, 201);
  });
}
