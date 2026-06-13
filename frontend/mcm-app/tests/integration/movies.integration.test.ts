/**
 * Movie proxy integration tests (T019) — US7 / FR-017..FR-021.
 *
 * HTTP-level against the running BFF + REAL mc-service + MongoDB — no mocking
 * (constitution v1.3.0). Covers every movie route+method (list/create/read/
 * update/delete + filter-options): authorized success proxied unchanged, 401/403
 * before any backend call (proven mock-free via typed error + state probe),
 * identity propagation, and unchanged backend domain errors.
 */
import { randomUUID } from 'node:crypto';
import {
  createTestUser,
  deleteTestUser,
  getTestTokens,
  assignRole,
  ensureRopcAudienceMapper,
  type TestUser,
} from './helpers/keycloak-test-client';
import { createBffClient } from './helpers/bff-test-server';

const bff = createBffClient();
const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });
const uniqueTitle = () => `IntMovie_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

// mc-service CreateMovieRequest requires every field present (non-Option Rust fields).
function movieBody(title: string, overrides: Record<string, unknown> = {}) {
  return {
    title, year: 2015, contentType: 'Movie', language: 'English',
    owned: true, ripped: false, childrens: false,
    ownedMedia: [], ripQuality: [], genres: ['Action'], rated: 'R',
    directors: [], actors: [], tags: [],
    movieSet: null, originalTitle: null, releaseDate: null,
    outline: null, plot: null, runtime: null, externalIds: [],
    ...overrides,
  };
}

function moviesOf(data: unknown): Array<{ movieId: string; title: string }> {
  const body = data as { items?: Array<{ movieId: string; title: string }> };
  return body.items ?? [];
}

describe('movie proxy — integration (real BFF + mc-service)', () => {
  let userA: TestUser;
  let userB: TestUser;
  let userNoRole: TestUser;
  let tokenA: string;
  let tokenB: string;
  let tokenNoRole: string;
  let collectionId: string;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    userA = await createTestUser('int-mov-a');
    await assignRole(userA.userId, 'mc-user');
    ({ accessToken: tokenA } = await getTestTokens(userA.username, userA.password));

    userB = await createTestUser('int-mov-b');
    await assignRole(userB.userId, 'mc-user');
    ({ accessToken: tokenB } = await getTestTokens(userB.username, userB.password));

    userNoRole = await createTestUser('int-mov-norole');
    ({ accessToken: tokenNoRole } = await getTestTokens(userNoRole.username, userNoRole.password));

    const coll = await bff.post('/bff-api/collections', { name: `IntMovColl_${randomUUID().slice(0, 8)}` }, auth(tokenA));
    collectionId = coll.data.collectionId;
  });

  afterAll(async () => {
    if (collectionId) await bff.delete(`/bff-api/collections/${collectionId}`, auth(tokenA)).catch(() => {});
    await deleteTestUser(userA?.userId);
    await deleteTestUser(userB?.userId);
    await deleteTestUser(userNoRole?.userId);
  });

  const moviesPath = () => `/bff-api/collections/${collectionId}/movies`;

  it('proxies authorized create/list/read/update/delete + filter-options unchanged (US7-AC1)', async () => {
    const title = uniqueTitle();

    // CREATE → 201 with movieId
    const created = await bff.post(moviesPath(), movieBody(title), auth(tokenA));
    expect(created.status).toBe(201);
    const movieId = created.data.movieId as string;
    expect(movieId).toBeTruthy();

    // LIST → includes it
    const list = await bff.get(moviesPath(), auth(tokenA));
    expect(list.status).toBe(200);
    expect(moviesOf(list.data).some((m) => m.movieId === movieId)).toBe(true);

    // READ → 200
    const read = await bff.get(`${moviesPath()}/${movieId}`, auth(tokenA));
    expect(read.status).toBe(200);
    expect(read.data.title).toBe(title);

    // UPDATE (PUT full replacement) → 200
    const put = await bff.put(`${moviesPath()}/${movieId}`, movieBody(title, { plot: 'updated' }), auth(tokenA));
    expect(put.status).toBe(200);

    // FILTER-OPTIONS → 200 with the FilterOptionsDto shape
    const fo = await bff.get(`${moviesPath()}/filter-options`, auth(tokenA));
    expect(fo.status).toBe(200);
    expect(fo.data).toHaveProperty('genres');

    // DELETE → 204
    const del = await bff.delete(`${moviesPath()}/${movieId}`, auth(tokenA));
    expect(del.status).toBe(204);
  });

  it('rejects unauthenticated movie requests as 401 before any backend call (US7-AC2)', async () => {
    const listRes = await bff.get(moviesPath());
    expect(listRes.status).toBe(401);
    expect(listRes.data.code).toBe('UNAUTHORIZED');

    const title = uniqueTitle();
    const postRes = await bff.post(moviesPath(), movieBody(title));
    expect(postRes.status).toBe(401);

    // backend-state probe (no mock): movie was not created
    const probe = await bff.get(moviesPath(), auth(tokenA));
    expect(moviesOf(probe.data).some((m) => m.title === title)).toBe(false);
  });

  it('rejects a caller lacking mc-user as 403 before any backend call (US7-AC3)', async () => {
    const listRes = await bff.get(moviesPath(), auth(tokenNoRole));
    expect(listRes.status).toBe(403);
    expect(listRes.data.code).toBe('FORBIDDEN');

    const title = uniqueTitle();
    const postRes = await bff.post(moviesPath(), movieBody(title), auth(tokenNoRole));
    expect(postRes.status).toBe(403);

    const probe = await bff.get(moviesPath(), auth(tokenA));
    expect(moviesOf(probe.data).some((m) => m.title === title)).toBe(false);
  });

  it('forwards the caller identity to the backend (US7-AC4)', async () => {
    // mc-service independently validates the forwarded JWT, so an authorized list
    // returns 200 only because the BFF propagated the caller's bearer token (a
    // missing/invalid forwarded token would make mc-service answer 401, as the
    // 401 test above shows the BFF short-circuits before forwarding).
    const res = await bff.get(moviesPath(), auth(tokenA));
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('items');

    // 011 DAC: collection-level access control is now enforced in EVERY movie handler
    // (authorize_collection_access). A different mc-user (B) has no ACL entry on A's
    // collection, so listing A's movies returns 404 — denial without information leak,
    // matching collections.integration AC4. (Updated from the pre-011 expectation of 200.)
    const bRes = await bff.get(moviesPath(), auth(tokenB));
    expect(bRes.status).toBe(404);
  });

  it('propagates backend domain errors unchanged (not-found, duplicate, validation) (US7-AC5)', async () => {
    // movie not-found: well-formed but nonexistent id
    const notFound = await bff.get(`${moviesPath()}/${'a'.repeat(24)}`, auth(tokenA));
    expect(notFound.status).toBe(404);

    // duplicate movie (same title+year per collection) → 409
    const title = uniqueTitle();
    const first = await bff.post(moviesPath(), movieBody(title), auth(tokenA));
    expect(first.status).toBe(201);
    const dup = await bff.post(moviesPath(), movieBody(title), auth(tokenA));
    expect(dup.status).toBe(409);
    await bff.delete(`${moviesPath()}/${first.data.movieId}`, auth(tokenA)).catch(() => {});

    // validation: missing required fields → 4xx
    const invalid = await bff.post(moviesPath(), { title: uniqueTitle() }, auth(tokenA));
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(invalid.status).toBeLessThan(500);
  });
});
