/**
 * Filter-options routing guard (010 US1, FR-001–FR-004).
 *
 * Regression guard (not a RED→GREEN cycle): the functional defect was already
 * fixed in feature 009 by relaxing validateObjectId to a safe-character whitelist,
 * so this test is green by design and exists to LOCK IN that `…/movies/filter-options`
 * resolves to the dedicated filter-options endpoint and is never 400'd at the edge
 * — preventing a re-tightening regression (FR-004) or a future route-shadow break.
 *
 * HTTP-level against the running BFF + real Keycloak (no mocking). Requires a
 * server built with the current code; point BFF_BASE_URL at it (dev container).
 *
 * Note on observability: the dedicated filter-options handler and the dynamic
 * [movieId] handler forward to the IDENTICAL upstream path, so handler identity is
 * not black-box observable — and is moot, because both yield the same result. The
 * meaningful, user-facing guarantee (SC-001) is asserted here: the request returns
 * the FilterOptionsDto and is never rejected at the edge.
 */
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

const FILTER_OPTION_KEYS = [
  'genres',
  'contentTypes',
  'rated',
  'languages',
  'decades',
  'ownedMedia',
  'ripQuality',
];

describe('filter-options routing guard (US1)', () => {
  let user: TestUser;
  let token: string;
  let collectionId: string;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    user = await createTestUser('fopts-user');
    await assignRole(user.userId, 'mc-user');
    ({ accessToken: token } = await getTestTokens(user.username, user.password));

    const created = await bff.post(
      '/bff-api/collections',
      { name: `fopts-${Date.now()}`, description: 'routing guard' },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    collectionId = created.data.collectionId ?? created.data.id;
  });

  afterAll(async () => {
    if (collectionId) {
      await bff.delete(`/bff-api/collections/${collectionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    await deleteTestUser(user?.userId);
  });

  it('serves the FilterOptionsDto for …/movies/filter-options (US1-AC2, SC-001)', async () => {
    const res = await bff.get(`/bff-api/collections/${collectionId}/movies/filter-options`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    for (const key of FILTER_OPTION_KEYS) {
      expect(res.data).toHaveProperty(key);
    }
  });

  it('does not 400 the "filter-options" sub-path at the edge (US1-AC4, FR-004)', async () => {
    const res = await bff.get(`/bff-api/collections/${collectionId}/movies/filter-options`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // A re-tightened strict-ObjectId check would 400 here (movieId="filter-options").
    expect(res.status).not.toBe(400);
  });
});
