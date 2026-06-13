/**
 * Movie count proxy integration test (013 T018) — US2-AC1 / US2-AC2.
 *
 * HTTP-level against the running BFF + REAL mc-service + MongoDB — no mocking
 * (constitution v1.3.0). Covers the new GET /bff-api/collections/:id/movies/count
 * route: authorized total, filtered count honouring a forwarded filter param, and
 * 401 before any backend call.
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
const uniqueTitle = () => `CntMovie_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

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

describe('movie count proxy — integration (real BFF + mc-service)', () => {
  let userA: TestUser;
  let tokenA: string;
  let collectionId: string;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    userA = await createTestUser('int-cnt-a');
    await assignRole(userA.userId, 'mc-user');
    ({ accessToken: tokenA } = await getTestTokens(userA.username, userA.password));

    const coll = await bff.post('/bff-api/collections', { name: `IntCntColl_${randomUUID().slice(0, 8)}` }, auth(tokenA));
    collectionId = coll.data.collectionId;

    // Seed 3 movies: 2 contentType=Movie, 1 contentType=Series.
    await bff.post(moviesPath(), movieBody(uniqueTitle(), { contentType: 'Movie' }), auth(tokenA));
    await bff.post(moviesPath(), movieBody(uniqueTitle(), { contentType: 'Movie' }), auth(tokenA));
    await bff.post(moviesPath(), movieBody(uniqueTitle(), { contentType: 'Series' }), auth(tokenA));
  });

  afterAll(async () => {
    if (collectionId) await bff.delete(`/bff-api/collections/${collectionId}`, auth(tokenA)).catch(() => {});
    await deleteTestUser(userA?.userId);
  });

  function moviesPath() {
    return `/bff-api/collections/${collectionId}/movies`;
  }
  const countPath = () => `${moviesPath()}/count`;

  it('returns the total movie count for the collection (US2-AC1)', async () => {
    const res = await bff.get(countPath(), auth(tokenA));
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ count: 3 });
  });

  it('returns the filtered count honouring a forwarded filter param (US2-AC2)', async () => {
    const res = await bff.get(`${countPath()}?contentType=Series`, auth(tokenA));
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ count: 1 });
  });

  it('rejects an unauthenticated count request as 401 before any backend call', async () => {
    const res = await bff.get(countPath());
    expect(res.status).toBe(401);
    expect(res.data.code).toBe('UNAUTHORIZED');
  });
});
