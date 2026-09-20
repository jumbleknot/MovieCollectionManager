/**
 * Verify before write (feature 073, T040 — FR-031/FR-032; SC-004; US3-AC3/AC4).
 *
 * THE ASSERTION IN EVERY CASE IS THE COLLECTION COUNT, before and after. Not that an error was
 * thrown. A restore that throws after creating three collections has still created three
 * collections, and the user is then worse off than before they tried to recover — which is the
 * single worst thing this feature could do, because it happens at the exact moment they are
 * already in trouble.
 *
 * Order is load-bearing: download → decompress → parse → check formatVersion → recompute
 * sha256 → ONLY THEN create anything. Checking the digest before the format version would hash
 * a body this code does not understand; creating anything before either is the bug.
 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { buildArtifact, compressArtifact } from '@/bff-server/backup-artifact';
import { restoreFromBytes } from '@/bff-server/backup-restore-writer';
import type { BackupArtifactCollection } from '@/types/backups';

import { createBffClient } from './helpers/bff-test-server';
import {
  createTestUser,
  deleteTestUser,
  getTestTokens,
  assignRole,
  ensureRopcAudienceMapper,
  type TestUser,
} from './helpers/keycloak-test-client';

const bff = createBffClient();

let user: TestUser;
let token: string;
const auth = () => ({ headers: { Authorization: `Bearer ${token}` } });

const movie = (title: string) => ({
  title,
  year: 2015,
  contentType: 'Movie',
  language: 'English',
  owned: true,
  ripped: false,
  childrens: false,
  ownedMedia: [],
  ripQuality: [],
  genres: ['Action'],
  rated: 'R',
  directors: [],
  actors: [],
  tags: [],
  movieSet: null,
  originalTitle: null,
  releaseDate: null,
  outline: null,
  plot: null,
  runtime: null,
  externalIds: [],
});

const sampleCollections = (): BackupArtifactCollection[] => [
  { id: 'c1', name: `Verify ${randomUUID().slice(0, 8)}`, description: 'x', movies: [movie('One'), movie('Two')] },
];

async function collectionCount(): Promise<number> {
  const res = await bff.get('/bff-api/collections', auth());
  const body = res.data as unknown[] | { items?: unknown[] };
  return (Array.isArray(body) ? body : (body.items ?? [])).length;
}

beforeAll(async () => {
  await ensureRopcAudienceMapper();
  user = await createTestUser('bk-verify');
  await assignRole(user.userId, 'mc-user');
  ({ accessToken: token } = await getTestTokens(user.username, user.password));
}, 120_000);

afterAll(async () => {
  // Remove anything a case did manage to create, so a failure here cannot leak into the next run.
  const res = await bff.get('/bff-api/collections', auth());
  const body = res.data as Array<{ collectionId?: string; id?: string }>;
  for (const c of Array.isArray(body) ? body : []) {
    const id = c.collectionId ?? c.id;
    if (id) await bff.delete(`/bff-api/collections/${id}`, auth());
  }
  if (user) await deleteTestUser(user.userId);
}, 120_000);

async function expectNothingCreated(bytes: Buffer, matcher: RegExp): Promise<void> {
  const before = await collectionCount();
  await expect(
    restoreFromBytes({ userId: user.userId, jwt: token, bytes, jobId: 'job-verify' }),
  ).rejects.toThrow(matcher);
  const after = await collectionCount();
  expect(after).toBe(before);
}

describe('a corrupt artifact creates NOTHING', () => {
  it('a flipped byte inside the gzip', async () => {
    const bytes = Buffer.from(compressArtifact(buildArtifact('job-verify', sampleCollections())));
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await expectNothingCreated(bytes, /backup/i);
  }, 120_000);

  it('a truncated object', async () => {
    const full = compressArtifact(buildArtifact('job-verify', sampleCollections()));
    await expectNothingCreated(full.subarray(0, Math.floor(full.length / 2)), /backup/i);
  }, 120_000);

  it('an unrecognised formatVersion is REFUSED, not best-effort parsed (FR-032)', async () => {
    // A future version may mean something different by the same field names. Guessing is how a
    // restore quietly writes wrong data into a user's account.
    const artifact = buildArtifact('job-verify', sampleCollections());
    const future = JSON.parse(JSON.stringify(artifact));
    future.manifest.formatVersion = 99;
    await expectNothingCreated(gzipSync(Buffer.from(JSON.stringify(future))), /format version/i);
  }, 120_000);

  it('a manifest whose counts disagree with the body', async () => {
    const artifact = buildArtifact('job-verify', sampleCollections());
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.manifest.collections[0].movieCount = 99;
    await expectNothingCreated(gzipSync(Buffer.from(JSON.stringify(tampered))), /manifest/i);
  }, 120_000);

  it('a body edited after the digest was computed', async () => {
    const artifact = buildArtifact('job-verify', sampleCollections());
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.collections[0].movies[0].title = 'Substituted';
    await expectNothingCreated(gzipSync(Buffer.from(JSON.stringify(tampered))), /integrity/i);
  }, 120_000);

  it('something that is not a backup at all', async () => {
    await expectNothingCreated(gzipSync(Buffer.from(JSON.stringify({ hello: 'world' }))), /backup/i);
  }, 120_000);
});

describe('the control — a healthy artifact DOES restore', () => {
  it('creates collections, so the cases above are not passing because restore never works', async () => {
    // Without this, a restore that refused everything would satisfy every assertion above.
    const before = await collectionCount();
    const result = await restoreFromBytes({
      userId: user.userId,
      jwt: token,
      bytes: compressArtifact(buildArtifact('job-verify', sampleCollections())),
      jobId: 'job-verify',
    });
    expect(result.createdCollectionIds).toHaveLength(1);
    expect(await collectionCount()).toBe(before + 1);
  }, 120_000);
});
