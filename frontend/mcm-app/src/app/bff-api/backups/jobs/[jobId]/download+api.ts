/**
 * BFF /bff-api/backups/jobs/{jobId}/download (feature 073, FR-028).
 *
 * Streams the artifact bytes so a user is not dependent on this system to read their own
 * backup — which is the point of writing to storage they control in the first place.
 *
 * FOLLOWS agent/export-download WITH ONE DELIBERATE DIFFERENCE: there, the handle is a
 * capability — unguessable, and possession is authorisation. Here the key is GUESSABLE (a job
 * id and a timestamp), so possession proves nothing and ownership is re-established from the
 * session on EVERY request, and the key is confined to this job's prefix.
 *
 * The audit record carries the key and the size only. The bytes are the user's whole
 * collection; nothing about their contents belongs in a log.
 */
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import * as destinationStore from '@/bff-server/backup-destination-store';
import * as jobStore from '@/bff-server/backup-job-store';
import { keyBelongsToJob } from '@/bff-server/backup-version-lister';
import { withBackupRoute, problem, notFound } from '@/bff-server/backup-route-support';
import { securityHeaders } from '@/bff-server/security-headers';
import { getBackupDestinationsCollection, getBackupJobsCollection } from '@/bff-server/mongo-client';
import { logger } from '@/bff-server/logger';
import type { BackupDestination, BackupJob } from '@/types/backups';

type Params = { jobId: string };

export async function GET(req: Request, { jobId }: Params): Promise<Response> {
  return withBackupRoute(req, 'backup_download', async ({ userId }) => {
    if (!(await jobStore.getJob(userId, jobId))) return notFound();

    const key = new URL(req.url).searchParams.get('key');
    if (!key) return problem('Invalid request', 400, 'A version key is required');

    const job = (await (await getBackupJobsCollection()).findOne({ _id: jobId, userId })) as BackupJob;
    const destinationDoc = (await (await getBackupDestinationsCollection()).findOne({
      _id: job.destinationId,
      userId,
    })) as BackupDestination | null;
    if (!destinationDoc) return notFound();
    if (!keyBelongsToJob(destinationDoc, job, key)) return notFound();

    const secret = await destinationStore.getDestinationSecret(userId, job.destinationId);
    if (secret === null) return problem('Destination unavailable', 409, 'No credential is stored for that destination');

    const driver = await createBackupDriver(destinationDoc, secret);
    const bytes = await driver.get(key);

    logger.audit('backup_downloaded', { userId, jobId, key, sizeBytes: bytes.byteLength });

    const filename = key.split('/').pop() ?? 'backup.json.gz';
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...securityHeaders(),
        'Content-Type': 'application/gzip',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });
}
