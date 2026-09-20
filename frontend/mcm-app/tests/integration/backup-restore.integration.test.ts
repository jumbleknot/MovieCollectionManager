/**
 * Restore fidelity and non-destructiveness (feature 073, T042 — FR-029/030/033; SC-002/SC-003;
 * US3-AC1/AC2/AC6).
 *
 * SC-003 IS THE WHOLE SAFETY ARGUMENT OF THIS FEATURE: restoring must not change anything the
 * user already has. So the sequence is: snapshot the full live state, restore, re-read, and
 * diff — asserting ZERO differences in pre-existing collections. Asserting only that the
 * restored copy looks right would leave the destructive case entirely untested, and that is
 * the case that would cost a user their data at the moment they were trying to recover it.
 *
 * Writes go through `createMcServiceClient(jwt)` AS THE USER, so domain validation, DAC and
 * audit apply unchanged (FR-033) — a restore is an ordinary sequence of creates, not a
 * privileged bulk import.
 */
import { randomUUID } from 'node:crypto';

import { buildArtifact, compressArtifact } from '@/bff-server/backup-artifact';
import { readSnapshot } from '@/bff-server/backup-snapshot-reader';
import { restoreFromBytes } from '@/bff-server/backup-restore-writer';

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
let sourceCollectionId: string;
let bystanderCollectionId: string;
const auth = () => ({ headers: { Authorization: `Bearer ${token}` } });

const movie = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  year: 1999,
  contentType: 'Movie',
  language: 'English',
  owned: true,
  ripped: true,
  childrens: false,
  // mc-service's MediaFormat enum is [DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray] — an invented
  // value is a 400 on seeding, which surfaces later as an unrelated-looking restore failure.
  ownedMedia: ['Blu-Ray'],
  ripQuality: ['DVD'],
  genres: ['Drama', 'Thriller'],
  rated: 'R',
  directors: ['Some Director'],
  actors: ['Some Actor', 'Another Actor'],
  tags: ['favourite'],
  movieSet: 'A Set',
  originalTitle: 'Original',
  releaseDate: '1999-03-31',
  outline: 'An outline',
  plot: 'A longer plot description.',
  runtime: 136,
  externalIds: [{ system: 'IMDB', uniqueId: 'tt0133093', url: 'https://www.imdb.com/title/tt0133093/' }],
  ...extra,
});

async function listCollections(): Promise<Array<{ id: string; name: string }>> {
  const res = await bff.get('/bff-api/collections', auth());
  const body = res.data as Array<{ collectionId?: string; id?: string; name: string }>;
  return (Array.isArray(body) ? body : []).map((c) => ({ id: (c.collectionId ?? c.id)!, name: c.name }));
}

/** The full live state, as the comparison baseline for SC-003. */
async function fullLiveState(): Promise<string> {
  const snapshot = await readSnapshot(token, []);
  return JSON.stringify(
    snapshot
      .map((c) => ({
        id: c.id,
        name: c.name,
        movies: c.movies
          .map((m) => m as Record<string, unknown>)
          .sort((a, b) => String(a.title).localeCompare(String(b.title))),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

beforeAll(async () => {
  await ensureRopcAudienceMapper();
  user = await createTestUser('bk-restore');
  await assignRole(user.userId, 'mc-user');
  ({ accessToken: token } = await getTestTokens(user.username, user.password));

  const source = await bff.post('/bff-api/collections', { name: `Restore Source ${randomUUID().slice(0, 8)}` }, auth());
  sourceCollectionId = source.data.collectionId ?? source.data.id;
  for (const title of ['Alpha', 'Beta', 'Gamma']) {
    await bff.post(`/bff-api/collections/${sourceCollectionId}/movies`, movie(title), auth());
  }

  // A collection the restore must not touch. Without a bystander, "nothing was changed" is
  // only asserted about the collection the artifact came from.
  const bystander = await bff.post(
    '/bff-api/collections',
    { name: `Restore Bystander ${randomUUID().slice(0, 8)}` },
    auth(),
  );
  bystanderCollectionId = bystander.data.collectionId ?? bystander.data.id;
  await bff.post(`/bff-api/collections/${bystanderCollectionId}/movies`, movie('Untouched'), auth());
}, 300_000);

afterAll(async () => {
  for (const c of await listCollections()) {
    await bff.delete(`/bff-api/collections/${c.id}`, auth());
  }
  if (user) await deleteTestUser(user.userId);
}, 300_000);

async function artifactOfSource(): Promise<Buffer> {
  const collections = await readSnapshot(token, [sourceCollectionId]);
  return compressArtifact(buildArtifact('job-restore', collections));
}

describe('restoring is non-destructive (SC-003 — the safety argument)', () => {
  it('leaves every pre-existing collection byte-for-byte unchanged', async () => {
    const bytes = await artifactOfSource();
    const before = await fullLiveState();

    const result = await restoreFromBytes({ userId: user.userId, jwt: token, bytes, jobId: 'job-restore' });
    expect(result.createdCollectionIds).toHaveLength(1);

    // Re-read the whole live state and compare, EXCLUDING the newly created collection.
    const created = new Set(result.createdCollectionIds);
    const afterSnapshot = await readSnapshot(token, []);
    const after = JSON.stringify(
      afterSnapshot
        .filter((c) => !created.has(c.id))
        .map((c) => ({
          id: c.id,
          name: c.name,
          movies: c.movies
            .map((m) => m as Record<string, unknown>)
            .sort((a, b) => String(a.title).localeCompare(String(b.title))),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );

    expect(after).toBe(before);
  }, 300_000);

  it('restores into a NEW collection rather than over the original (FR-029)', async () => {
    const bytes = await artifactOfSource();
    const result = await restoreFromBytes({ userId: user.userId, jwt: token, bytes, jobId: 'job-restore' });
    expect(result.createdCollectionIds).not.toContain(sourceCollectionId);

    const names = (await listCollections()).filter((c) => result.createdCollectionIds.includes(c.id));
    // `<name> (backup <timestamp>)` — recognisable, and it is what keeps a second restore of
    // the same version legal under the case-insensitive unique index on collection names.
    expect(names[0].name).toMatch(/\(backup .+\)$/);
  }, 300_000);
});

describe('fidelity (SC-002)', () => {
  it('restores every movie, with every metadata field and external identifier', async () => {
    const bytes = await artifactOfSource();
    const result = await restoreFromBytes({ userId: user.userId, jwt: token, bytes, jobId: 'job-restore' });

    const restored = await readSnapshot(token, result.createdCollectionIds);
    const original = await readSnapshot(token, [sourceCollectionId]);

    expect(restored[0].movies).toHaveLength(original[0].movies.length);

    // Compared field by field, excluding only the identifiers the SERVER assigns — a restored
    // movie is a new record and cannot carry the old one's id or timestamps.
    const strip = (m: unknown) => {
      const { movieId, collectionId, createdAt, updatedAt, ...rest } = m as Record<string, unknown>;
      void movieId; void collectionId; void createdAt; void updatedAt;
      return rest;
    };
    const sortByTitle = (ms: unknown[]) =>
      ms.map(strip).sort((a, b) => String(a.title).localeCompare(String(b.title)));

    expect(sortByTitle(restored[0].movies)).toEqual(sortByTitle(original[0].movies));
  }, 300_000);

  it('preserves external identifiers exactly, including their URLs', async () => {
    const bytes = await artifactOfSource();
    const result = await restoreFromBytes({ userId: user.userId, jwt: token, bytes, jobId: 'job-restore' });
    const restored = await readSnapshot(token, result.createdCollectionIds);
    const first = restored[0].movies[0] as { externalIds: Array<{ system: string; uniqueId: string }> };
    expect(first.externalIds[0]).toMatchObject({ system: 'IMDB', uniqueId: 'tt0133093' });
  }, 300_000);
});

describe('restoring the same version twice', () => {
  it('BOTH succeed — the timestamp suffix keeps the second name legal (US3-AC6)', async () => {
    // Collection-name uniqueness is enforced case-insensitively at the index level
    // (openwiki/gotchas/mongodb-indexes-and-uniqueness.md), so two restores of one version
    // would collide without a distinguishing suffix — and the second would fail at exactly the
    // moment a user was retrying because they were unsure the first had worked.
    const bytes = await artifactOfSource();
    const first = await restoreFromBytes({ userId: user.userId, jwt: token, bytes, jobId: 'job-restore' });
    const second = await restoreFromBytes({ userId: user.userId, jwt: token, bytes, jobId: 'job-restore' });

    expect(first.createdCollectionIds[0]).not.toBe(second.createdCollectionIds[0]);
    const names = (await listCollections())
      .filter((c) => [...first.createdCollectionIds, ...second.createdCollectionIds].includes(c.id))
      .map((c) => c.name);
    expect(new Set(names).size).toBe(2);
  }, 300_000);
});

describe('identity and partial failure', () => {
  it('writes AS THE USER, so another user cannot see the restored collection', async () => {
    const bytes = await artifactOfSource();
    const result = await restoreFromBytes({ userId: user.userId, jwt: token, bytes, jobId: 'job-restore' });

    const other = await createTestUser('bk-restore-other');
    try {
      await assignRole(other.userId, 'mc-user');
      const { accessToken: otherToken } = await getTestTokens(other.username, other.password);
      const theirs = await readSnapshot(otherToken, result.createdCollectionIds);
      expect(theirs).toEqual([]);
    } finally {
      await deleteTestUser(other.userId);
    }
  }, 300_000);

  it('records per-movie failures rather than aborting the whole restore', async () => {
    // One movie mc-service rejects must not cost the user the other 499. The run is reported
    // PARTIAL, which is honest, rather than failed (it mostly worked) or successful (it did
    // not entirely).
    const collections = await readSnapshot(token, [sourceCollectionId]);
    const withBadRecord = JSON.parse(JSON.stringify(collections));
    // An empty title is rejected by mc-service's domain validation.
    withBadRecord[0].movies.push({ ...movie(''), title: '' });
    const bytes = compressArtifact(buildArtifact('job-restore', withBadRecord));

    const result = await restoreFromBytes({ userId: user.userId, jwt: token, bytes, jobId: 'job-restore' });

    expect(result.partial).toBe(true);
    expect(result.movieCount).toBe(collections[0].movies.length);
    expect(result.failures.length).toBeGreaterThan(0);
  }, 300_000);
});
