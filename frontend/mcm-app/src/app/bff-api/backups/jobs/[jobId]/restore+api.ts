/**
 * BFF /bff-api/backups/jobs/{jobId}/restore (feature 073, FR-029/031/032).
 *
 * A THIN CALLER of the artifact verification and the restore writer. No validation logic lives
 * in this handler, deliberately: if the verify-before-write ordering were implemented here, a
 * second entry point added later could bypass it. It lives in `restoreFromBytes`, which is the
 * only exported way in.
 *
 * 422 for an artifact that fails its checks — the request was well formed and the SERVER
 * refused to act on the content. Nothing was written (FR-031/FR-032), and the response says so.
 */
import { ArtifactVerificationError } from '@/bff-server/backup-artifact';
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import * as destinationStore from '@/bff-server/backup-destination-store';
import * as jobStore from '@/bff-server/backup-job-store';
import { restoreFromBytes } from '@/bff-server/backup-restore-writer';
import { keyBelongsToJob } from '@/bff-server/backup-version-lister';
import {
  withBackupRoute,
  parseJsonBody,
  json,
  problem,
  notFound,
} from '@/bff-server/backup-route-support';
import { getBackupDestinationsCollection, getBackupJobsCollection } from '@/bff-server/mongo-client';
import type { BackupDestination, BackupJob } from '@/types/backups';

type Params = { jobId: string };

export async function POST(req: Request, { jobId }: Params): Promise<Response> {
  return withBackupRoute(req, 'backup_restore', async ({ userId, jwt }) => {
    if (!(await jobStore.getJob(userId, jobId))) return notFound();

    const body = await parseJsonBody(req);
    if (!body.ok) return body.response;
    const key = (body.value as { key?: unknown }).key;
    if (typeof key !== 'string' || key === '') return problem('Invalid request', 400, 'A version key is required');

    const job = (await (await getBackupJobsCollection()).findOne({ _id: jobId, userId })) as BackupJob;
    const destinationDoc = (await (await getBackupDestinationsCollection()).findOne({
      _id: job.destinationId,
      userId,
    })) as BackupDestination | null;
    if (!destinationDoc) return notFound();

    // The key comes from the client and is GUESSABLE, so it is confined to this job's prefix
    // here rather than trusted. Without this, a key naming another job's object — or a
    // traversal out of the prefix — would be fetched and restored.
    if (!keyBelongsToJob(destinationDoc, job, key)) return notFound();

    const secret = await destinationStore.getDestinationSecret(userId, job.destinationId);
    if (secret === null) return problem('Destination unavailable', 409, 'No credential is stored for that destination');

    const driver = await createBackupDriver(destinationDoc, secret);
    const bytes = await driver.get(key);

    try {
      const result = await restoreFromBytes({ userId, jwt, bytes, jobId });
      return json({
        createdCollectionIds: result.createdCollectionIds,
        movieCount: result.movieCount,
        partial: result.partial,
      });
    } catch (err) {
      if (err instanceof ArtifactVerificationError) {
        // Nothing was written. The message is one this feature constructed and names no
        // upstream content.
        return problem('That backup could not be restored', 422, err.message);
      }
      throw err;
    }
  });
}
