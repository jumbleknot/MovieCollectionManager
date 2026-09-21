// Keep the last N versions at the destination (feature 073, T063 — FR-025/026/027).
//
// THE WHOLE ALGORITHM IS "LIST, SORT, DELETE THE TAIL", and it is that simple on purpose. The
// artifact key ends in an ISO-8601 timestamp, and ISO-8601 sorts lexicographically in the same
// order it sorts chronologically, so the destination's own key ordering IS the age ordering.
// Nothing has to be parsed, and nothing has to be remembered between runs.
//
// THAT IS ALSO WHY A FAILED PRUNE NEEDS NO RETRY STATE. If a delete fails, the object is still
// there, so the next run lists it again and tries again. There is no queue to persist, nothing
// to reconcile, and no way for the system's idea of what is owed to drift from what is there.
//
// A FAILED RUN PRUNES NOTHING (FR-026). This is the safety property, not the feature: pruning on
// the failure path turns "today's backup did not happen" into "and yesterday's is gone too",
// which the user discovers at restore. `pruneAfterRun` makes that decision here rather than
// leaving it to each caller's discipline.

import { keyBelongsToJob } from '@/bff-server/backup-version-lister';
import { logger } from '@/bff-server/logger';
import type { BackupDestinationDriver } from '@/bff-server/backup-destination-driver';
import type { BackupDestination, BackupRunStatus } from '@/types/backups';

export interface PruneOutcome {
  prunedCount: number;
  /**
   * Safe, user-facing, and DELIBERATELY SEPARATE from the run's own failureReason (FR-027). A
   * prune that failed has not cost the user the backup that was just written; reporting the run
   * as failed would say that it had.
   */
  failureReason?: string;
}

/** `<basePath>/<jobId>/` — the only prefix this job's artifacts can live under. */
function jobPrefix(destination: BackupDestination, jobId: string): string {
  return `${destination.basePath || 'mcm-backups'}/${jobId}/`;
}

/**
 * Delete this job's artifacts beyond the newest `keepLast`.
 *
 * ONLY THIS JOB'S ARTIFACTS ARE EVEN CANDIDATES (US5-AC5). Two filters do that, and both are
 * needed: the prefix bounds it to this job, and `keyBelongsToJob` re-checks the same rule while
 * rejecting a traversal segment. Anything else under that prefix — another job's objects, or a
 * file the user keeps at a destination they own — is not ours to delete. It is skipped by the
 * artifact-name check rather than by the prefix, because the user's own file can sit inside
 * this job's folder.
 */
export async function pruneOldVersions(
  driver: BackupDestinationDriver,
  destination: BackupDestination,
  jobId: string,
  keepLast: number,
): Promise<PruneOutcome> {
  const prefix = jobPrefix(destination, jobId);
  const objects = await driver.list(prefix);

  const ours = objects
    .map((o) => o.key)
    // Only keys this feature writes: `<iso>.json.gz`. A user's own file under the same folder
    // is not an artifact and is never a deletion candidate.
    .filter((key) => ARTIFACT_KEY.test(key))
    .filter((key) => keyBelongsToJob(destination, { _id: jobId } as never, key))
    // Lexicographic IS chronological for these keys — see the header note.
    .sort();

  if (!Number.isInteger(keepLast) || keepLast < 1) {
    // A nonsensical retention count must not be read as "keep none". Refusing to act is the
    // only safe interpretation of an input that would otherwise delete everything.
    return { prunedCount: 0, failureReason: 'The retention count is not a whole number of backups to keep.' };
  }

  const doomed = ours.slice(0, Math.max(0, ours.length - keepLast));
  if (doomed.length === 0) return { prunedCount: 0 };

  let prunedCount = 0;
  let failures = 0;
  for (const key of doomed) {
    try {
      await driver.delete(key);
      prunedCount += 1;
    } catch (err) {
      // CARRY ON. One transient refusal must not abandon the whole prune, or a destination
      // fills up because of a single failed delete. The error is counted, not propagated.
      failures += 1;
      logger.warn('Backup retention could not remove an old version', {
        action: 'backup_prune_failed',
        jobId,
        error: err,
      });
    }
  }

  return {
    prunedCount,
    // Constructed here and naming no upstream content: this string is persisted on the run and
    // shown to the user, and a driver error can carry an S3 error document that echoes the
    // request.
    ...(failures > 0
      ? {
          failureReason:
            `Some older backups could not be removed (${failures} of ${doomed.length}). ` +
            'They will be retried after the next successful backup.',
        }
      : {}),
  };
}

/** `<iso-8601>.json.gz` — the shape this feature writes, and nothing else. */
const ARTIFACT_KEY = /\/\d{4}-\d{2}-\d{2}T[\d:.]+Z\.json\.gz$/;

/**
 * Prune only when the run actually succeeded (FR-025/FR-026).
 *
 * The status check lives HERE rather than at the call site so that the rule holds for every
 * caller, including ones written later. A `partial` run counts as not-successful: it means some
 * of the user's data did not make it into the new artifact, which is the worst possible moment
 * to delete an older one that might have had it.
 */
export async function pruneAfterRun(
  driver: BackupDestinationDriver,
  destination: BackupDestination,
  jobId: string,
  keepLast: number,
  status: BackupRunStatus,
): Promise<PruneOutcome> {
  if (status !== 'success') return { prunedCount: 0 };
  return pruneOldVersions(driver, destination, jobId, keepLast);
}
