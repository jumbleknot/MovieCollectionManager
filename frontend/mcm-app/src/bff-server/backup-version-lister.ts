// List a job's versions AT THE DESTINATION (feature 073, FR-028; US3-AC5).
//
// Read from the destination, not from run history. Run history records what this system
// believes it did; the destination is the user's own storage and is authoritative about its
// own contents. Listing from history would hide an object someone removed elsewhere, and would
// hide one this system did not write — both of which the user needs to see, because the whole
// point of writing to storage they control is that they can also act on it directly.
//
// USABLE IS NOT THE SAME AS PRESENT. A zero-length or unreadable object is LISTED — it exists,
// and its space is being used — but is never offered for restore. Hiding it would be a lie
// about the destination; offering it would send the user to a failure at the exact moment they
// are already in trouble.

import { decompressArtifact, verifyArtifact } from '@/bff-server/backup-artifact';
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import * as destinationStore from '@/bff-server/backup-destination-store';
import { getBackupDestinationsCollection } from '@/bff-server/mongo-client';
import { logger } from '@/bff-server/logger';
import type { BackupDestination, BackupJob, BackupVersion } from '@/types/backups';

/**
 * How many objects are opened to check usability.
 *
 * Usability cannot be decided on SIZE alone: a valid-looking gzip whose digest does not match
 * is non-zero and parses, and only opening it catches that. But opening every object turns a
 * page load into a download of the whole history, so the newest few are checked properly and
 * older ones are judged on what listing already told us. The newest are the ones a user
 * actually restores from, and an older one is verified anyway before anything is written.
 */
const DEEP_CHECK_COUNT = 5;

export async function listBackupVersions(
  userId: string,
  job: BackupJob,
): Promise<BackupVersion[]> {
  const destinationDoc = await (await getBackupDestinationsCollection()).findOne({
    _id: job.destinationId,
    userId,
  });
  if (!destinationDoc) return [];
  const secret = await destinationStore.getDestinationSecret(userId, job.destinationId);
  if (secret === null) return [];

  const destination = destinationDoc as BackupDestination;
  const driver = await createBackupDriver(destination, secret);
  const prefix = `${destination.basePath || 'mcm-backups'}/${job._id}/`;

  const objects = await driver.list(prefix);

  // NEWEST FIRST. Keys carry an ISO-8601 timestamp, so reversing lexicographic order is
  // chronological — the same property retention relies on.
  const sorted = [...objects].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

  const versions: BackupVersion[] = [];
  for (const [index, object] of sorted.entries()) {
    const createdAt = timestampFromKey(object.key) ?? object.lastModified;

    if (object.sizeBytes === 0) {
      versions.push({ key: object.key, createdAt, sizeBytes: 0, usable: false });
      continue;
    }
    if (index >= DEEP_CHECK_COUNT) {
      versions.push({ key: object.key, createdAt, sizeBytes: object.sizeBytes, usable: true });
      continue;
    }

    let usable = true;
    try {
      verifyArtifact(decompressArtifact(await driver.get(object.key)));
    } catch (err) {
      usable = false;
      logger.warn('Backup version present but not usable', {
        action: 'backup_version_unusable',
        userId,
        jobId: job._id,
        // The KEY, not the error message — the message can carry decoder internals, and the
        // key is what identifies the object to anyone looking at the destination.
        key: object.key,
        reason: (err as Error).name,
      });
    }
    versions.push({ key: object.key, createdAt, sizeBytes: object.sizeBytes, usable });
  }
  return versions;
}

/** The artifact key ends in an ISO-8601 timestamp; prefer it to the server's own mtime. */
function timestampFromKey(key: string): string | null {
  const match = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\.json\.gz$/.exec(key);
  return match ? match[1] : null;
}

/**
 * Confirm a key belongs to this job before it is downloaded or restored.
 *
 * The key arrives from the client, and the download handle is NOT a capability — the key is
 * guessable. So ownership is re-established on every request from the session, and a key
 * outside this job's prefix is refused rather than fetched.
 */
export function keyBelongsToJob(destination: BackupDestination, job: BackupJob, key: string): boolean {
  const prefix = `${destination.basePath || 'mcm-backups'}/${job._id}/`;
  // `startsWith` is necessary but NOT sufficient: `..` in the remainder could walk out of the
  // prefix at the server, so a traversal segment disqualifies the key outright.
  return key.startsWith(prefix) && !key.includes('..');
}
