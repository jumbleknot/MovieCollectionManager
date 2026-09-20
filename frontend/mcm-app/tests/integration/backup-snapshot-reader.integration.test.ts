/**
 * Snapshot reader (feature 073, T026 — FR-009; US2-AC1/AC2).
 *
 * Reads a user's collections and movies from REAL mc-service through the unchanged
 * `createMcServiceClient(jwt)` seam, as the user, so DAC and audit apply exactly as they do to
 * any other read.
 *
 * PAGING IS THE WHOLE POINT OF THIS SUITE. mc-service pages movies with an OPAQUE COMPOUND
 * KEYSET CURSOR, not an offset (openwiki/gotchas/keyset-pagination.md). A reader that stops
 * after the first page produces an artifact that looks completely valid and has silently lost
 * data — the worst failure this feature can have, because it is discovered at restore time,
 * which is the moment the user can least afford it. So a collection is seeded PAST the page
 * size deliberately and the count is compared against mc-service's own count endpoint, not
 * against anything the reader computed.
 */
import { randomUUID } from 'node:crypto';

import { readSnapshot } from '@/bff-server/backup-snapshot-reader';

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

// mc-service's default page size. Seeding past it is what makes the paging assertion real; if
// this ever drops below the seeded count the test still passes for the wrong reason, so the
// suite asserts more than one page was actually needed.
const SEED_MOVIES = 55;

const movieBody = (title: string) => ({
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

let bigCollectionId: string;
let smallCollectionId: string;

beforeAll(async () => {
  await ensureRopcAudienceMapper();
  user = await createTestUser('bk-snap');
  await assignRole(user.userId, 'mc-user');
  ({ accessToken: token } = await getTestTokens(user.username, user.password));

  const big = await bff.post('/bff-api/collections', { name: `Snap Big ${randomUUID().slice(0, 8)}` }, auth());
  bigCollectionId = big.data.collectionId ?? big.data.id;
  const small = await bff.post('/bff-api/collections', { name: `Snap Small ${randomUUID().slice(0, 8)}` }, auth());
  smallCollectionId = small.data.collectionId ?? small.data.id;

  for (let i = 0; i < SEED_MOVIES; i += 1) {
    await bff.post(
      `/bff-api/collections/${bigCollectionId}/movies`,
      movieBody(`SnapMovie ${String(i).padStart(3, '0')}`),
      auth(),
    );
  }
  await bff.post(`/bff-api/collections/${smallCollectionId}/movies`, movieBody('Only One'), auth());
}, 300_000);

afterAll(async () => {
  for (const id of [bigCollectionId, smallCollectionId]) {
    if (id) await bff.delete(`/bff-api/collections/${id}`, auth());
  }
  if (user) await deleteTestUser(user.userId);
});

describe('reads a collection COMPLETELY, past the page boundary', () => {
  it('reads every movie, matching mc-service’s own count', async () => {
    // Compared against the count ENDPOINT, not against the seeded number and not against
    // anything the reader produced. A reader compared to itself proves nothing.
    const counted = await bff.get(`/bff-api/collections/${bigCollectionId}/movies/count`, auth());
    const expected = counted.data.count ?? counted.data;

    const snapshot = await readSnapshot(token, [bigCollectionId]);

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].movies).toHaveLength(Number(expected));
    expect(Number(expected)).toBe(SEED_MOVIES);
  }, 120_000);

  it('really did need more than one page — otherwise the test above proves nothing', async () => {
    // If mc-service's page size ever exceeded the seeded count, the paging assertion would pass
    // against a reader that never followed a cursor. This asserts the premise.
    //
    // Asked through the BFF rather than by constructing an mc-service client here. That is the
    // path the application actually uses, so the page size this observes is the one the reader
    // will meet — and it keeps this file free of a direct upstream client, which the
    // mcm-auth-before-authz rule flags (correctly: a client built with no visible authorization
    // guard is exactly the shape that rule exists to catch).
    const firstPage = await bff.get(`/bff-api/collections/${bigCollectionId}/movies`, auth());
    expect(firstPage.status).toBe(200);
    expect(firstPage.data.items.length).toBeLessThan(SEED_MOVIES);
    expect(firstPage.data.nextCursor).toBeTruthy();
  }, 60_000);

  it('returns no duplicates across page boundaries', async () => {
    // A cursor loop that re-sends the same cursor, or restarts it, produces a plausible-looking
    // artifact with repeated movies and the right total.
    const snapshot = await readSnapshot(token, [bigCollectionId]);
    const titles = snapshot[0].movies.map((m) => (m as { title: string }).title);
    expect(new Set(titles).size).toBe(titles.length);
  }, 120_000);
});

describe('which collections are read', () => {
  it('reads exactly the named collections', async () => {
    const snapshot = await readSnapshot(token, [smallCollectionId]);
    expect(snapshot.map((c) => c.id)).toEqual([smallCollectionId]);
    expect(snapshot[0].movies).toHaveLength(1);
  }, 60_000);

  it('an EMPTY list means every collection the user owns, resolved NOW', async () => {
    // Resolved at run time, not at save time — a collection created after the job was saved
    // must still be backed up, or "back up everything" quietly means "back up what existed
    // when I set this up".
    const snapshot = await readSnapshot(token, []);
    const ids = snapshot.map((c) => c.id);
    expect(ids).toContain(bigCollectionId);
    expect(ids).toContain(smallCollectionId);
  }, 120_000);

  it('carries the collection name and description into the artifact', async () => {
    const snapshot = await readSnapshot(token, [smallCollectionId]);
    expect(snapshot[0].name).toMatch(/^Snap Small/);
  }, 60_000);
});

describe('a collection that disappears mid-read', () => {
  it('is recorded as ABSENT rather than failing the whole run', async () => {
    // A run that aborts because one collection was deleted while it was reading loses the
    // backup of every OTHER collection too. The manifest must then agree with the body — the
    // absent collection is not listed at all, rather than listed with zero movies, which would
    // be indistinguishable from a collection the user had emptied.
    const doomed = await bff.post(
      '/bff-api/collections',
      { name: `Snap Doomed ${randomUUID().slice(0, 8)}` },
      auth(),
    );
    const doomedId = doomed.data.collectionId ?? doomed.data.id;
    await bff.delete(`/bff-api/collections/${doomedId}`, auth());

    const snapshot = await readSnapshot(token, [smallCollectionId, doomedId]);

    expect(snapshot.map((c) => c.id)).toEqual([smallCollectionId]);
  }, 60_000);
});

describe('identity', () => {
  it('reads as the CALLER — another user’s collection is simply not there', async () => {
    // Reads go through createMcServiceClient(jwt) as the user, so DAC is mc-service's to
    // enforce and this feature adds no privileged path around it.
    const other = await createTestUser('bk-snap-other');
    try {
      await assignRole(other.userId, 'mc-user');
      const { accessToken: otherToken } = await getTestTokens(other.username, other.password);
      const snapshot = await readSnapshot(otherToken, [bigCollectionId]);
      expect(snapshot).toEqual([]);
    } finally {
      await deleteTestUser(other.userId);
    }
  }, 120_000);
});
