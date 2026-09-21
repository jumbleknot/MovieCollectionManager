// One backup run, end to end (feature 073, FR-008/012/014).
//
// Sequence, and the order is the design:
//
//   1. Resolve the destination and decrypt its credential (transiently).
//   2. Read the snapshot from mc-service AS THE USER.
//   3. Build the artifact and compute its digest.
//   4. Write ONE object.
//   5. Record the run.
//
// NOTHING IS WRITTEN UNTIL THE WHOLE SNAPSHOT IS IN HAND. That is why the artifact is built in
// memory and PUT as a single object rather than streamed: a stream that fails half way leaves a
// partial object at the destination, and a partial object is later listed as a restorable
// version. The user then discovers what it really is at the moment they need it. The cost of
// that choice is a memory ceiling, which is enforced explicitly and fails loudly (FR-015)
// rather than being papered over with streaming.
//
// A FAILED RUN LEAVES NO OBJECT. Because the single PUT is the only write, a failure before it
// leaves nothing, and a failure of the PUT itself leaves nothing an S3 or WebDAV server would
// expose as a complete object.

import { buildArtifact, compressArtifact } from '@/bff-server/backup-artifact';
import {
  OfflineTokenUnusableError,
  mintUserAccessToken,
} from '@/bff-server/backup-offline-token';
import { getBackupJobsCollection } from '@/bff-server/mongo-client';
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import { pruneAfterRun } from '@/bff-server/backup-retention';
import { DestinationUrlNotAllowedError } from '@/bff-server/backup-destination-url-guard';
import * as destinationStore from '@/bff-server/backup-destination-store';
import { readSnapshot } from '@/bff-server/backup-snapshot-reader';
import * as runStore from '@/bff-server/backup-run-store';
import { getBackupDestinationsCollection } from '@/bff-server/mongo-client';
import { env } from '@/config/env';
import { logger } from '@/bff-server/logger';
import { acquireLock, releaseLock } from '@/bff-server/redis-lock';
import { incrementRateLimit } from '@/bff-server/cache-service';
import { RateLimitError } from '@/types/errors';
import type {
  BackupCollectionCount,
  BackupDestination,
  BackupJob,
  BackupRun,
  BackupTrigger,
} from '@/types/backups';

// ─── The per-user run gate and on-demand rate limit (FR-012/FR-013) ───────────
//
// TWO SEPARATE CONTROLS answering two different questions. The SLOT answers "is this user
// already backing up?" — one run at a time, because two concurrent runs of the same job write
// two artifacts and double the load on mc-service for no benefit. The RATE LIMIT answers "how
// often may they start one?" — a user who presses the button repeatedly is not prevented by the
// slot once each run finishes.

/**
 * TTL on the run slot, matched to the run-timeout ceiling.
 *
 * It exists because a run can die without releasing: the process killed, the container
 * restarted, the host rebooted. Without an expiry that user can never back up again, and
 * nothing in the UI would explain why — the fix would be someone deleting a Redis key. Thirty
 * minutes is longer than any run this feature permits (the size ceiling sees to that) and short
 * enough that a wedged user recovers without help.
 */
export const BACKUP_RUN_SLOT_TTL_SECONDS = 30 * 60;

const RUN_SLOT_LOCK = (userId: string) => `running:${userId}`;

// Deliberately generous. This is not a security control — the slot and the size ceiling are.
// It is here so a stuck retry loop in a client cannot hammer mc-service, and a limit tight
// enough to annoy a legitimate user would be doing the wrong job.
const RUN_RATE_LIMIT = { endpoint: 'backup-run', limit: 30, windowSeconds: 3600, retryAfterSeconds: 300 };

/**
 * Take this user's single run slot. False means a run is already in flight — the caller turns
 * that into 409, which is a normal answer and not an error.
 */
export async function acquireUserRunSlot(
  userId: string,
  ttlSeconds: number = BACKUP_RUN_SLOT_TTL_SECONDS,
): Promise<boolean> {
  return acquireLock(RUN_SLOT_LOCK(userId), userId, ttlSeconds);
}

/**
 * Release the slot. The holder id IS the userId, so this is a no-op for a slot the user does
 * not hold — including one that already expired and was retaken, which must not be deleted out
 * from under whatever retook it.
 */
export async function releaseUserRunSlot(userId: string): Promise<void> {
  await releaseLock(RUN_SLOT_LOCK(userId), userId);
}

/** Throws RateLimitError (429, with a retry hint) when this user has started too many runs. */
export async function checkBackupRunRateLimit(userId: string): Promise<void> {
  const count = await incrementRateLimit(RUN_RATE_LIMIT.endpoint, userId, RUN_RATE_LIMIT.windowSeconds);
  if (count > RUN_RATE_LIMIT.limit) {
    throw new RateLimitError(RUN_RATE_LIMIT.retryAfterSeconds);
  }
}

export interface RunRequest {
  userId: string;
  /** The user's own token. Reads and writes happen as them, never as a service identity. */
  jwt: string;
  job: BackupJob;
  trigger: BackupTrigger;
}

/** `<basePath>/<jobId>/<ISO timestamp>.json.gz` — ISO-8601 so keys sort chronologically. */
export function artifactKeyFor(basePath: string, jobId: string, createdAt: string): string {
  return `${basePath || 'mcm-backups'}/${jobId}/${createdAt}.json.gz`;
}

/**
 * Raised when a run would exceed a configured ceiling (FR-015).
 *
 * Its message is USER-FACING and passes through `safeReason` verbatim, because it is the only
 * thing telling an operator what to raise. It therefore names BOTH the limit and the measured
 * value: "too large" is not actionable, "20 movies against a limit of 5" is.
 */
export class BackupSizeCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupSizeCeilingError';
  }
}

/**
 * Check both ceilings BEFORE anything is written.
 *
 * Two units, checked independently, because they fail in different situations: a large library
 * of ordinary records is count-bound, while a handful of records with long plot text is
 * bytes-bound and passes any plausible count ceiling. A ceiling that only ever fires on one of
 * them is half a ceiling.
 *
 * This is the explicit, loud cost of NOT streaming. The runner holds the whole artifact in
 * memory so a failure cannot leave a partial object at the destination; that trade is only
 * defensible if the memory bound is enforced rather than hoped for.
 */
function assertWithinCeilings(movieCount: number, uncompressedBytes: number): void {
  const maxMovies = env.backupMaxMovies;
  if (Number.isFinite(maxMovies) && maxMovies > 0 && movieCount > maxMovies) {
    throw new BackupSizeCeilingError(
      `This backup covers ${movieCount} movies, which is over the limit of ${maxMovies}. ` +
        'Back up fewer collections, or ask an administrator to raise BACKUP_MAX_MOVIES.',
    );
  }
  const maxBytes = env.backupMaxUncompressedBytes;
  if (Number.isFinite(maxBytes) && maxBytes > 0 && uncompressedBytes > maxBytes) {
    throw new BackupSizeCeilingError(
      `This backup is ${uncompressedBytes} bytes before compression, which is over the limit ` +
        `of ${maxBytes} bytes. Back up fewer collections, or ask an administrator to raise ` +
        'BACKUP_MAX_UNCOMPRESSED_BYTES.',
    );
  }
}

/**
 * A safe, user-facing failure reason.
 *
 * Deliberately narrow. An error from the driver can carry an S3 error document that echoes the
 * request; one from axios can carry a URL with a query string. This reason is persisted on the
 * run and shown in the UI, so only messages this code constructed are allowed through.
 */
function safeReason(err: unknown): string {
  if (err instanceof DestinationUrlNotAllowedError) return err.reason;
  // Constructed here, names no upstream content, and is the only guidance the operator gets.
  if (err instanceof BackupSizeCeilingError) return err.message;
  const message = err instanceof Error ? err.message : '';
  // Driver messages are constructed by this feature and carry a status and an error CODE only.
  if (/^(S3|WebDAV) [A-Z]+ failed: HTTP \d+/.test(message)) return message;
  if (/^That backup/.test(message)) return message;
  return 'The backup could not be completed. Check the destination and try again.';
}

export async function runBackup(request: RunRequest): Promise<BackupRun> {
  const { userId, jwt, job, trigger } = request;
  const run = await runStore.startRun(userId, job._id, trigger);

  try {
    const destinationDoc = await (await getBackupDestinationsCollection()).findOne({
      _id: job.destinationId,
      userId,
    });
    if (!destinationDoc) throw new Error('That backup destination no longer exists');
    const secret = await destinationStore.getDestinationSecret(userId, job.destinationId);
    if (secret === null) throw new Error('No credential is stored for that destination');

    // Guard runs here too, via the factory. A hostname that was safe when the destination was
    // saved can resolve somewhere else by the time a scheduled run writes to it, so the
    // save-time check alone would be a check of the past.
    const driver = await createBackupDriver(destinationDoc as BackupDestination, secret);

    const collections = await readSnapshot(jwt, job.collectionIds);
    const createdAt = new Date().toISOString();
    const artifact = buildArtifact(job._id, collections, createdAt);

    // BEFORE the write, and before compression — the ceiling is about what had to be held in
    // memory, and the compressed size is not that. Nothing has been written at this point, so
    // throwing here leaves the destination untouched, which is the property the suite asserts
    // (object count zero, not merely "it threw").
    const uncompressed = Buffer.byteLength(JSON.stringify(artifact), 'utf8');
    assertWithinCeilings(artifact.manifest.totalMovieCount, uncompressed);

    const body = compressArtifact(artifact);

    const key = artifactKeyFor(
      (destinationDoc as BackupDestination).basePath,
      job._id,
      createdAt,
    );
    await driver.put(key, body, 'application/gzip');

    const collectionCounts: BackupCollectionCount[] = collections.map((c) => ({
      collectionId: c.id,
      name: c.name,
      movieCount: c.movies.length,
    }));

    // PRUNE ONLY NOW — after the PUT above has returned, so the new artifact is confirmed
    // written before any old one is considered for deletion (FR-025). Pruning first, or
    // concurrently, would open a window in which the user has fewer versions than they asked
    // for and no new one yet; if the write then failed they would be down a backup for nothing.
    //
    // Reached on the SUCCESS path only. `pruneAfterRun` re-checks that itself, so the rule
    // survives a future caller that forgets (FR-026).
    //
    // A prune failure NEVER fails the run (FR-027): the backup the user just asked for did
    // happen, and reporting it as failed would say otherwise. It is recorded in its own field,
    // and because retention is "list, sort, delete the tail" the next successful run simply
    // sees the same objects again and retries — there is no retry state to keep.
    const prune = await pruneAfterRun(
      driver,
      destinationDoc as BackupDestination,
      job._id,
      job.keepLast,
      'success',
    );

    const finished = await runStore.finishRun(run._id, {
      status: 'success',
      artifactKey: key,
      artifactBytes: body.byteLength,
      collectionCounts,
      prunedCount: prune.prunedCount,
      ...(prune.failureReason ? { pruneFailureReason: prune.failureReason } : {}),
    });
    logger.audit('backup_run_succeeded', {
      userId,
      jobId: job._id,
      runId: run._id,
      trigger,
      collectionCount: collections.length,
      movieCount: artifact.manifest.totalMovieCount,
      artifactBytes: body.byteLength,
      prunedCount: prune.prunedCount,
    });
    return finished ?? { ...run, status: 'success', artifactKey: key, collectionCounts };
  } catch (err) {
    const failureReason = safeReason(err);
    // The run is recorded FAILED and returned, not thrown. A scheduled run has no caller to
    // catch anything, and a manual one needs the failure in history rather than as a 500.
    const finished = await runStore.finishRun(run._id, { status: 'failed', failureReason });
    logger.error('Backup run failed', {
      action: 'backup_run_failed',
      userId,
      jobId: job._id,
      runId: run._id,
      trigger,
      error: err,
    });
    return finished ?? { ...run, status: 'failed', failureReason };
  }
}

/**
 * One UNATTENDED run: mint the user's own token from their standing permission, then run
 * exactly the same backup a "back up now" would (feature 073, T053 — FR-021/FR-024; US4-AC7).
 *
 * THE MINT COMES FIRST, AND A FAILED MINT ENDS IT. Nothing is read, nothing is written, and no
 * other identity is tried (FR-024) — there is no service-account path here to fall back to,
 * because a backup that quietly succeeded using broader privilege than the user granted would
 * be a worse outcome than one that failed.
 *
 * The failure is recorded as a RUN, not thrown. A scheduled run has no caller to catch
 * anything, and the user needs to find the reason in their run history rather than in a log
 * they cannot see.
 */
export async function runScheduledBackup(userId: string, jobId: string): Promise<BackupRun> {
  const job = await (await getBackupJobsCollection()).findOne({ _id: jobId, userId });
  if (!job) throw new Error('That backup job no longer exists');

  let jwt: string;
  try {
    jwt = await mintUserAccessToken(userId);
  } catch (err) {
    if (!(err instanceof OfflineTokenUnusableError)) throw err;
    // Its message is user-facing by construction and names the remedy, so it is passed through
    // verbatim: "unauthorized" would leave the user with a job that has silently stopped and
    // nothing they could do about it.
    const run = await runStore.startRun(userId, jobId, 'scheduled');
    const failed = await runStore.finishRun(run._id, {
      status: 'failed',
      failureReason: err.message,
    });
    logger.error('Scheduled backup could not authenticate as the user', {
      action: 'backup_run_failed',
      userId,
      jobId,
      runId: run._id,
      trigger: 'scheduled',
      reason: 'offline_grant_unusable',
    });
    return failed ?? { ...run, status: 'failed', failureReason: err.message };
  }

  return runBackup({ userId, jwt, job, trigger: 'scheduled' });
}
