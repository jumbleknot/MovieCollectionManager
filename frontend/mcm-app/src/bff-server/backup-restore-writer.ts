// Restore an artifact into NEW collections (feature 073, FR-029/030/031/032/033).
//
// THE GUARANTEE THIS FILE EXISTS TO KEEP: restoring never changes anything the user already
// has. Nothing here updates or deletes; the only write is a create. That is a stronger promise
// than "we are careful to restore into a new collection", because there is no code path that
// could do otherwise.
//
// VERIFY BEFORE WRITE, and the ordering is enforced structurally: `restoreFromBytes` is the
// ONLY exported entry point, and it decompresses, verifies and only then calls the writer. The
// writer is not exported, so a second caller cannot be added later that skips the check — which
// is exactly how a verify-then-write invariant usually decays.
//
// WRITES GO THROUGH `createMcServiceClient(jwt)` AS THE USER. A restore is an ordinary sequence
// of creates: domain validation, DAC and audit apply exactly as they would if the user typed
// every record in. This feature has no privileged bulk-import path, deliberately — one would be
// a way to put records into mc-service that its own rules had never seen.

import type { AxiosInstance } from 'axios';

import { decompressArtifact, verifyArtifact } from '@/bff-server/backup-artifact';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { logger } from '@/bff-server/logger';
import type { BackupArtifact, BackupArtifactCollection } from '@/types/backups';

/** How many movie creates are in flight at once. */
const CONCURRENCY = 4;

export interface RestoreRequest {
  userId: string;
  jwt: string;
  bytes: Buffer;
  jobId: string;
}

export interface RestoreFailure {
  collectionName: string;
  movieTitle?: string;
  reason: string;
}

export interface RestoreResult {
  createdCollectionIds: string[];
  /** Movies actually created. Compare with the manifest total to see what a partial cost. */
  movieCount: number;
  partial: boolean;
  failures: RestoreFailure[];
}

/**
 * mc-service caps a collection name at 50 characters.
 *
 * FOUND BY RUNNING THIS: a name of ordinary length plus the backup suffix exceeds it, and
 * mc-service answers 400 — so the restore fails ENTIRELY, at the moment the user needs it, for
 * a collection they named perfectly reasonably. The suffix must therefore be budgeted for, not
 * merely appended.
 */
const MAX_COLLECTION_NAME = 50;

/** Attempts to find a free name before giving up. */
const MAX_NAME_ATTEMPTS = 20;

/**
 * `<name> (backup <timestamp>)`, guaranteed to fit, with `attempt` disambiguating a clash.
 *
 * The suffix is not decoration. Collection-name uniqueness is enforced CASE-INSENSITIVELY at
 * the MongoDB index level (openwiki/gotchas/mongodb-indexes-and-uniqueness.md), so restoring
 * the same version twice would collide on the second attempt — which is precisely when a user
 * retries, being unsure the first one worked.
 *
 * The timestamp is minute-resolution rather than full ISO: it is there to tell restores apart
 * for a human reading a list, and every character it costs is a character taken from the name
 * the user chose. Two restores within the same minute are then disambiguated by `attempt`,
 * which is also what handles a name a previous restore already took.
 *
 * The ORIGINAL NAME is what gets truncated when something has to give, never the suffix: a
 * name missing its tail is still recognisable, while a name missing its suffix would collide
 * or, worse, look like the user's own collection.
 */
function restoredName(originalName: string, timestamp: string, attempt: number): string {
  const suffix = attempt <= 1 ? ` (backup ${timestamp})` : ` (backup ${timestamp} ${attempt})`;
  const room = MAX_COLLECTION_NAME - suffix.length;
  const base = originalName.length > room ? originalName.slice(0, Math.max(0, room)).trimEnd() : originalName;
  return `${base}${suffix}`;
}

/** mc-service assigns these; a restored record is a NEW record and cannot claim the old ones. */
function stripServerAssigned(movie: unknown): Record<string, unknown> {
  const { movieId, collectionId, createdAt, updatedAt, ...rest } = movie as Record<string, unknown>;
  void movieId;
  void collectionId;
  void createdAt;
  void updatedAt;
  return rest;
}

/** A safe reason. mc-service returns RFC 9457 Problem Details; only its `title` is surfaced. */
function failureReason(err: unknown): string {
  const problem = (err as { response?: { data?: { title?: string; detail?: string }; status?: number } }).response;
  if (problem?.data?.title) return problem.data.title;
  if (problem?.status) return `mc-service answered HTTP ${problem.status}`;
  return 'That record could not be restored';
}

/**
 * Create the restored collection, stepping the name on a 409 until one is free.
 *
 * mc-service answers 409 for a duplicate name (DomainError::DuplicateCollectionName). Retrying
 * with a stepped suffix is what makes "restore the same version twice" work — and two restores
 * inside the same minute produce the same minute-resolution timestamp, so this is the ordinary
 * path, not an edge case.
 */
async function createCollection(
  client: AxiosInstance,
  collection: BackupArtifactCollection,
  timestamp: string,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    try {
      const res = await client.post('/api/v1/collections', {
        name: restoredName(collection.name, timestamp, attempt),
        ...(collection.description ? { description: collection.description } : {}),
      });
      const body = res.data as { collectionId?: string; id?: string };
      const id = body.collectionId ?? body.id;
      if (!id) throw new Error('mc-service did not return an id for the restored collection');
      return id;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 409 && attempt < MAX_NAME_ATTEMPTS) continue;
      throw err;
    }
  }
  throw new Error('Could not find an unused name for the restored collection');
}

/**
 * Create movies with bounded concurrency, recording per-movie failures rather than aborting.
 *
 * One record mc-service rejects — a field that no longer passes validation, say — must not cost
 * the user the other four hundred. The result is reported PARTIAL, which is honest: not failed,
 * because most of it worked, and not successful, because not all of it did.
 */
async function createMovies(
  client: AxiosInstance,
  collectionId: string,
  collectionName: string,
  movies: unknown[],
  failures: RestoreFailure[],
): Promise<number> {
  let created = 0;
  for (let i = 0; i < movies.length; i += CONCURRENCY) {
    const batch = movies.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (movie) => {
        try {
          await client.post(`/api/v1/collections/${collectionId}/movies`, stripServerAssigned(movie));
          return true;
        } catch (err) {
          failures.push({
            collectionName,
            movieTitle: (movie as { title?: string }).title,
            reason: failureReason(err),
          });
          return false;
        }
      }),
    );
    created += results.filter(Boolean).length;
  }
  return created;
}

/** NOT exported: reachable only through `restoreFromBytes`, which has already verified. */
async function writeArtifact(
  request: Omit<RestoreRequest, 'bytes'>,
  artifact: BackupArtifact,
): Promise<RestoreResult> {
  const client = createMcServiceClient(request.jwt);
  // One timestamp for the whole restore, so a multi-collection restore is recognisable as one
  // act rather than as several that happened to be seconds apart.
  // Minute resolution: enough for a human to tell two restores apart in a list, and every
  // character it costs comes out of the user's own collection name (see restoredName).
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const createdCollectionIds: string[] = [];
  const failures: RestoreFailure[] = [];
  let movieCount = 0;

  for (const collection of artifact.collections) {
    const collectionId = await createCollection(client, collection, timestamp);
    createdCollectionIds.push(collectionId);
    movieCount += await createMovies(
      client,
      collectionId,
      collection.name,
      collection.movies,
      failures,
    );
  }

  const result: RestoreResult = {
    createdCollectionIds,
    movieCount,
    partial: failures.length > 0,
    failures,
  };

  logger.audit('backup_restored', {
    userId: request.userId,
    jobId: request.jobId,
    collectionCount: createdCollectionIds.length,
    movieCount,
    partial: result.partial,
    failureCount: failures.length,
  });
  return result;
}

/**
 * The ONLY way to restore. Download → decompress → parse → check formatVersion → recompute
 * sha256 → and only then create anything.
 *
 * A failure at any step throws BEFORE the first create, so nothing exists afterwards. That is
 * asserted by counting collections, not by catching the error: a restore that threw after
 * creating three collections has still created three, and has left the user worse off at the
 * moment they were already in trouble.
 */
export async function restoreFromBytes(request: RestoreRequest): Promise<RestoreResult> {
  const artifact = decompressArtifact(request.bytes);
  verifyArtifact(artifact);
  return writeArtifact(request, artifact);
}
