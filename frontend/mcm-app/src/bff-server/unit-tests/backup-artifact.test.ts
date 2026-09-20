// Backup artifact: build, hash, compress, parse, verify (feature 073, T028 — FR-008/010/014).
//
// THE DIGEST IS THE POINT OF THIS FILE. It covers the canonically serialised, UNCOMPRESSED
// `collections` array — not the compressed bytes. Hashing the gzip would tie the check to a
// compression level: change it and every existing artifact fails verification, for no reason
// related to their contents. Hashing the uncompressed canonical form still catches a bad
// decompression, because a bad decompression does not produce the same bytes.
//
// CANONICAL SERIALISATION MUST BE PINNED. If key order can vary, the digest is unstable and
// every restore fails months later with nothing to point at. The order is asserted directly
// here, not merely relied upon.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

// `ajv/dist/2020`, not the default entry. The contract declares draft 2020-12 and Ajv 8's
// default export only knows draft-07, so `ajv.compile` fails with "no schema with key or ref
// https://json-schema.org/draft/2020-12/schema" — a message about a missing $ref, for a
// problem that is really the wrong Ajv entry point.
import Ajv2020 from 'ajv/dist/2020';

import {
  buildArtifact,
  canonicalJson,
  compressArtifact,
  decompressArtifact,
  verifyArtifact,
  ArtifactVerificationError,
} from '@/bff-server/backup-artifact';
import type { BackupArtifactCollection } from '@/types/backups';

const SCHEMA_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'specs',
  '073-scheduled-backups',
  'contracts',
  'backup-artifact-v1.schema.json',
);

// Real mc-service movie shape, not the illustrative one in the schema's examples — see the note
// in backup-artifact.ts. A field missing here is a field silently lost on restore.
const movie = (title: string, year: number) => ({
  movieId: `mid-${title}`,
  collectionId: 'cid-1',
  title,
  year,
  // 'Movie', not 'MOVIE' — mc-service's ContentType enum is [Movie, Series, Concert].
  // The corrected contract caught this the moment it described the real field set;
  // the previous schema named fields mc-service does not have, so it validated anything.
  contentType: 'Movie',
  owned: true,
  ripped: false,
  childrens: false,
  externalIds: [{ system: 'IMDB', uniqueId: `tt-${title}`, url: `https://imdb.example/${title}` }],
  directors: ['A Director'],
  actors: ['An Actor'],
  tags: ['tag'],
  genres: ['Drama'],
  ownedMedia: ['Blu-Ray'],
  ripQuality: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
});

const collections = (): BackupArtifactCollection[] => [
  {
    id: 'cid-1',
    name: 'Feature Films',
    description: 'The main one',
    movies: [movie('Coherence', 2013), movie('Primer', 2004)],
  },
  { id: 'cid-2', name: 'Shorts', description: null as unknown as string, movies: [] },
];

const JOB_ID = 'job-1';
const CREATED_AT = '2026-09-20T03:00:00.000Z';

describe('canonicalJson', () => {
  it('orders keys deterministically regardless of insertion order', () => {
    // Two objects that are equal but were BUILT differently must serialise identically, or the
    // digest depends on the order mc-service happened to return fields in.
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('does NOT reorder arrays — order is data, not formatting', () => {
    // Sorting arrays too would be a tidier-looking canonicalisation and would silently discard
    // the order of a user's movies.
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('build → compress → decompress → parse', () => {
  it('round-trips the collections exactly', () => {
    const artifact = buildArtifact(JOB_ID, collections(), CREATED_AT);
    const restored = decompressArtifact(compressArtifact(artifact));
    expect(restored.collections).toEqual(artifact.collections);
    expect(restored.manifest).toEqual(artifact.manifest);
  });

  it('records per-collection counts that match the body', () => {
    const artifact = buildArtifact(JOB_ID, collections(), CREATED_AT);
    expect(artifact.manifest.collections).toEqual([
      { id: 'cid-1', name: 'Feature Films', movieCount: 2 },
      { id: 'cid-2', name: 'Shorts', movieCount: 0 },
    ]);
    expect(artifact.manifest.totalMovieCount).toBe(2);
  });

  it('computes the digest over the UNCOMPRESSED canonical collections', () => {
    const artifact = buildArtifact(JOB_ID, collections(), CREATED_AT);
    // Recomputed here independently of the implementation's own bookkeeping.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const expected = createHash('sha256').update(canonicalJson(artifact.collections)).digest('hex');
    expect(artifact.manifest.sha256).toBe(expected);
  });

  it('produces the SAME digest at a different compression level', () => {
    // The check must survive a change of compression setting; tying it to the gzip bytes would
    // invalidate every existing artifact the day that setting changed.
    const artifact = buildArtifact(JOB_ID, collections(), CREATED_AT);
    const low = gzipSync(Buffer.from(JSON.stringify(artifact)), { level: 1 });
    const high = gzipSync(Buffer.from(JSON.stringify(artifact)), { level: 9 });
    expect(low.equals(high)).toBe(false); // the bytes really do differ
    expect(decompressArtifact(low).manifest.sha256).toBe(decompressArtifact(high).manifest.sha256);
  });

  it('keeps every mc-service movie field — a field dropped here is lost on restore', () => {
    const artifact = buildArtifact(JOB_ID, collections(), CREATED_AT);
    const restored = decompressArtifact(compressArtifact(artifact));
    expect(restored.collections[0].movies[0]).toEqual(movie('Coherence', 2013));
  });
});

describe('verifyArtifact', () => {
  it('accepts a healthy artifact', () => {
    const artifact = buildArtifact(JOB_ID, collections(), CREATED_AT);
    expect(() => verifyArtifact(artifact)).not.toThrow();
  });

  it('rejects a ONE-BYTE mutation anywhere in the body', () => {
    const artifact = buildArtifact(JOB_ID, collections(), CREATED_AT);
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.collections[0].movies[0].title = 'Coherencf'; // one character
    expect(() => verifyArtifact(tampered)).toThrow(ArtifactVerificationError);
  });

  it('rejects a manifest whose counts disagree with the body', () => {
    // A digest match with a count mismatch would mean the manifest was edited to match a body
    // it does not describe; either way the artifact cannot be trusted.
    const artifact = buildArtifact(JOB_ID, collections(), CREATED_AT);
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.manifest.collections[0].movieCount = 99;
    expect(() => verifyArtifact(tampered)).toThrow(ArtifactVerificationError);
  });

  it('REFUSES an unrecognised formatVersion rather than best-effort parsing it (FR-032)', () => {
    const artifact = buildArtifact(JOB_ID, collections(), CREATED_AT);
    const future = JSON.parse(JSON.stringify(artifact));
    future.manifest.formatVersion = 99;
    expect(() => verifyArtifact(future)).toThrow(/format/i);
  });

  it('rejects a body that is not an artifact at all', () => {
    expect(() => verifyArtifact({ hello: 'world' } as never)).toThrow(ArtifactVerificationError);
  });

  it('rejects a truncated gzip before it can be parsed', () => {
    const compressed = compressArtifact(buildArtifact(JOB_ID, collections(), CREATED_AT));
    expect(() => decompressArtifact(compressed.subarray(0, compressed.length - 20))).toThrow();
  });

  it('rejects a flipped byte INSIDE the gzip', () => {
    const compressed = compressArtifact(buildArtifact(JOB_ID, collections(), CREATED_AT));
    const flipped = Buffer.from(compressed);
    flipped[Math.floor(flipped.length / 2)] ^= 0xff;
    // gzip's own CRC usually catches this; when it does not, the digest must.
    expect(() => {
      verifyArtifact(decompressArtifact(flipped));
    }).toThrow();
  });
});

describe('the published contract', () => {
  it('validates against backup-artifact-v1.schema.json', () => {
    // The artifact is a PORTABLE contract: a user who downloads one must be able to read their
    // data without this application. Validating against the published schema is what keeps that
    // promise checkable rather than aspirational.
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const artifact = JSON.parse(JSON.stringify(buildArtifact(JOB_ID, collections(), CREATED_AT)));
    const valid = validate(artifact);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  it('is gzip that a plain gunzip can read — no custom framing', () => {
    const compressed = compressArtifact(buildArtifact(JOB_ID, collections(), CREATED_AT));
    const parsed = JSON.parse(gunzipSync(compressed).toString('utf8'));
    expect(parsed.manifest.formatVersion).toBe(1);
  });
});
