/**
 * BFF /bff-api/backups/jobs/{jobId}/versions (feature 073, FR-028; US3-AC5).
 *
 * Reads the destination directly, so the list reflects what is actually there — including
 * objects this system did not write and versions removed elsewhere since. A version that is
 * present but unreadable is listed with `usable: false` rather than hidden: it exists, and
 * pretending otherwise would misdescribe the user's own storage.
 */
import * as jobStore from '@/bff-server/backup-job-store';
import { listBackupVersions } from '@/bff-server/backup-version-lister';
import { withBackupRoute, json, notFound } from '@/bff-server/backup-route-support';
import { getBackupJobsCollection } from '@/bff-server/mongo-client';
import type { BackupJob } from '@/types/backups';

type Params = { jobId: string };

export async function GET(req: Request, { jobId }: Params): Promise<Response> {
  return withBackupRoute(req, 'backup_version_list', async ({ userId }) => {
    if (!(await jobStore.getJob(userId, jobId))) return notFound();
    const job = (await (await getBackupJobsCollection()).findOne({ _id: jobId, userId })) as BackupJob;
    return json(await listBackupVersions(userId, job));
  });
}
