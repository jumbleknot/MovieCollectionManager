// Read a user's collections and movies from mc-service for backup (feature 073, FR-009).
//
// Reads go through the UNCHANGED `createMcServiceClient(jwt)` seam, as the user. This feature
// adds no privileged read path: DAC, validation and audit are mc-service's, exactly as for any
// other read, and a collection the user cannot see is a collection this cannot back up.
//
// PAGING IS WHERE A SILENT TRUNCATION WOULD COME FROM. mc-service pages movies with an OPAQUE
// COMPOUND KEYSET CURSOR, not an offset (openwiki/gotchas/keyset-pagination.md). A reader that
// takes the first page and stops produces an artifact that parses, verifies, matches its own
// manifest — and has lost data. That failure surfaces at RESTORE, which is the moment the user
// can least afford it. So this follows `nextCursor` until it is null, and refuses to loop for
// ever if the server ever returns one that does not advance.

import type { AxiosInstance } from 'axios';

import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { logger } from '@/bff-server/logger';
import type { BackupArtifactCollection } from '@/types/backups';

/**
 * A ceiling on cursor iterations. Not a page limit — a runaway guard.
 *
 * Without it, a server bug that returns the same cursor for ever turns a backup run into an
 * infinite loop holding the user's run lock, and the symptom is "backups stopped happening"
 * with a process quietly spinning. With it the run FAILS, loudly, which is recoverable.
 */
const MAX_PAGES = 10_000;

interface CollectionSummary {
  collectionId?: string;
  id?: string;
  name: string;
  description?: string | null;
}

async function listCollections(client: AxiosInstance): Promise<CollectionSummary[]> {
  const res = await client.get('/api/v1/collections');
  const body = res.data as CollectionSummary[] | { items?: CollectionSummary[] };
  return Array.isArray(body) ? body : (body.items ?? []);
}

/** Every movie in one collection, following the keyset cursor to the end. */
async function readAllMovies(client: AxiosInstance, collectionId: string): Promise<unknown[]> {
  const movies: unknown[] = [];
  let cursor: string | null = null;
  let pages = 0;
  const seenCursors = new Set<string>();

  do {
    const res = await client.get(`/api/v1/collections/${collectionId}/movies`, {
      params: cursor ? { cursor } : {},
    });
    const body = res.data as { items?: unknown[]; nextCursor?: string | null };
    movies.push(...(body.items ?? []));

    const next = body.nextCursor ?? null;
    // A cursor that repeats means the server is not advancing. Continuing would loop for ever
    // and reading it as "done" would silently truncate — so it is an error either way, and an
    // error is the honest one.
    if (next && seenCursors.has(next)) {
      throw new Error(`mc-service returned a repeating page cursor for collection ${collectionId}`);
    }
    if (next) seenCursors.add(next);
    cursor = next;
    pages += 1;
    if (pages > MAX_PAGES) {
      throw new Error(`Reading collection ${collectionId} exceeded ${MAX_PAGES} pages`);
    }
  } while (cursor);

  return movies;
}

/**
 * Read the named collections in full. An EMPTY list means every collection the user owns,
 * resolved NOW.
 *
 * Resolving at run time rather than at save time is what makes "back up everything" keep
 * meaning everything: a collection created after the job was saved is included, where a list
 * frozen at save time would quietly exclude it for ever.
 *
 * A collection that has DISAPPEARED between being listed and being read is omitted, not fatal.
 * Failing the whole run would lose the backup of every other collection because one was
 * deleted while it was being read. It is omitted entirely rather than recorded with zero
 * movies, because "zero movies" is indistinguishable from a collection the user emptied on
 * purpose, and the manifest must describe what the body actually contains.
 */
export async function readSnapshot(
  jwt: string,
  collectionIds: string[],
): Promise<BackupArtifactCollection[]> {
  const client = createMcServiceClient(jwt);
  const all = await listCollections(client);
  const idOf = (c: CollectionSummary) => c.collectionId ?? c.id ?? '';

  const selected =
    collectionIds.length === 0 ? all : all.filter((c) => collectionIds.includes(idOf(c)));

  const snapshot: BackupArtifactCollection[] = [];
  for (const collection of selected) {
    const id = idOf(collection);
    try {
      const movies = await readAllMovies(client, id);
      snapshot.push({
        id,
        name: collection.name,
        description: collection.description ?? undefined,
        movies,
      });
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404 || status === 403) {
        // Gone, or no longer visible to this user, between the listing and the read.
        logger.warn('Collection disappeared mid-backup; omitted from the artifact', {
          action: 'backup_collection_absent',
          collectionId: id,
          status,
        });
        continue;
      }
      throw err;
    }
  }
  return snapshot;
}
