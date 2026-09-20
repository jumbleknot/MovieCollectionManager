// Backup artifact: build, hash, compress, parse, verify (feature 073, FR-008/010/014/031/032).
//
// The artifact is a PORTABLE CONTRACT, not an internal format. A user who downloads one must be
// able to read their own data without this application — that is the whole point of writing to
// storage they control. So it is plain gzip of plain JSON, with no custom framing, and it
// validates against contracts/backup-artifact-v1.schema.json.
//
// THE DIGEST covers the canonically serialised, UNCOMPRESSED `collections` array. Not the
// compressed bytes: hashing those would bind the check to a compression LEVEL, so changing that
// setting would invalidate every artifact ever written, for a reason unrelated to their
// contents. The uncompressed form still catches a bad decompression, because a bad
// decompression does not yield the same bytes.
//
// MOVIE FIELDS. The schema's `properties` for a movie are illustrative and name fields
// (`releaseYear`, `externalIdentifiers`) that mc-service does not have; its own description
// says api-specs/mc-service-api.yaml is authoritative and that the implementation must
// reconcile the two. It is reconciled by storing the mc-service movie representation VERBATIM.
// The schema permits that (a movie requires only `title` and allows further properties), and it
// is the only choice that cannot silently lose a field — a field missing from the artifact is a
// field gone from the restore, discovered when it matters most.

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

import {
  BACKUP_FORMAT_VERSION,
  type BackupArtifact,
  type BackupArtifactCollection,
  type ManifestCollectionCount,
} from '@/types/backups';

/** Raised for any artifact that cannot be trusted. Restore turns this into a 422, never a 500. */
export class ArtifactVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactVerificationError';
  }
}

/**
 * Deterministic JSON: object keys sorted, arrays left ALONE.
 *
 * Sorting arrays too would look like a more thorough canonicalisation and would silently
 * discard the order of a user's movies — order is data here, not formatting.
 *
 * This ordering is PINNED BEHAVIOUR, asserted directly by the unit suite. If it can vary
 * between Node versions or between two objects that differ only in insertion order, the digest
 * is unstable and restores start failing months later with nothing to point at.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is not representable in JSON; dropping it here rather than letting
    // JSON.stringify do it keeps the digest input and the serialised body identical.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function digestOf(collections: BackupArtifactCollection[]): string {
  return createHash('sha256').update(canonicalJson(collections)).digest('hex');
}

// The manifest names this field `id`, because the PUBLISHED schema does. A run record names the
// same thing `collectionId`. They are converted where they meet, rather than one object
// carrying both spellings.
function countsOf(collections: BackupArtifactCollection[]): ManifestCollectionCount[] {
  return collections.map((c) => ({ id: c.id, name: c.name, movieCount: c.movies.length }));
}

export function buildArtifact(
  jobId: string,
  collections: BackupArtifactCollection[],
  createdAt: string = new Date().toISOString(),
): BackupArtifact {
  return {
    manifest: {
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt,
      jobId,
      collections: countsOf(collections),
      totalMovieCount: collections.reduce((n, c) => n + c.movies.length, 0),
      sha256: digestOf(collections),
    },
    collections,
  };
}

/** Level 9: the artifact is written once and read rarely, so size beats CPU here. */
export function compressArtifact(artifact: BackupArtifact): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(artifact), 'utf8'), { level: 9 });
}

/**
 * Decompress and parse. THROWS on anything that is not readable gzip holding JSON — a truncated
 * or corrupt object must fail here, loudly, rather than yield a half-object that verification
 * then has to reason about.
 */
export function decompressArtifact(compressed: Buffer): BackupArtifact {
  let text: string;
  try {
    text = gunzipSync(compressed).toString('utf8');
  } catch (err) {
    throw new ArtifactVerificationError(
      `That backup could not be decompressed: ${(err as Error).name}`,
    );
  }
  try {
    return JSON.parse(text) as BackupArtifact;
  } catch {
    throw new ArtifactVerificationError('That backup is not readable as a backup file');
  }
}

/**
 * Prove an artifact before ANYTHING is written from it (FR-031).
 *
 * Order is load-bearing: shape, then formatVersion, then counts, then digest. Checking the
 * digest first would mean a body from a future format version — which might not even be an
 * object — gets hashed before anyone asks whether this code understands it.
 */
export function verifyArtifact(artifact: BackupArtifact): void {
  if (!artifact || typeof artifact !== 'object' || !artifact.manifest || !Array.isArray(artifact.collections)) {
    throw new ArtifactVerificationError('That backup is not readable as a backup file');
  }
  const { manifest, collections } = artifact;

  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    // REFUSED, not best-effort parsed (FR-032). A future version may mean something different
    // by the same field names, and guessing at it is how a restore quietly writes wrong data.
    throw new ArtifactVerificationError(
      `That backup is in format version ${manifest.formatVersion}, which this version of MCM does not understand`,
    );
  }

  if (!Array.isArray(manifest.collections) || manifest.collections.length !== collections.length) {
    throw new ArtifactVerificationError('That backup’s manifest does not describe its contents');
  }
  for (const declared of manifest.collections) {
    const actual = collections.find((c) => c.id === declared.id);
    if (!actual || actual.movies.length !== declared.movieCount) {
      // A count mismatch with a matching digest means the manifest was edited to describe a
      // body it does not describe. Either way the artifact cannot be trusted.
      throw new ArtifactVerificationError('That backup’s manifest does not match its contents');
    }
  }

  const totalDeclared = manifest.totalMovieCount;
  const totalActual = collections.reduce((n, c) => n + c.movies.length, 0);
  if (totalDeclared !== totalActual) {
    throw new ArtifactVerificationError('That backup’s manifest does not match its contents');
  }

  if (digestOf(collections) !== manifest.sha256) {
    throw new ArtifactVerificationError(
      'That backup failed its integrity check and was not restored',
    );
  }
}
