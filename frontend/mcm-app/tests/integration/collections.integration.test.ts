/**
 * Collection proxy integration tests (T018) — US7 / FR-017..FR-021.
 *
 * HTTP-level against the running BFF + REAL mc-service + MongoDB — no mocking
 * (constitution v1.3.0). Drives every collection route+method with a real ROPC
 * session, asserting: authorized success proxied unchanged, 401 (no session) and
 * 403 (wrong role) rejected BEFORE any backend call, caller identity propagated,
 * and backend domain errors propagated unchanged.
 *
 * "Before any backend call" is proven mock-free: the response is the BFF's typed
 * auth error (not a proxied body/5xx), AND for write methods a backend-state probe
 * (authorized list) confirms no collection was created.
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
const uniqueName = () => `IntColl_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

function collectionsOf(data: unknown): Array<{ collectionId: string; name: string }> {
  const body = data as { items?: Array<{ collectionId: string; name: string }> };
  return (body.items ?? (data as Array<{ collectionId: string; name: string }>)) ?? [];
}

describe('collections proxy — integration (real BFF + mc-service)', () => {
  let userA: TestUser;
  let userB: TestUser;
  let userNoRole: TestUser;
  let tokenA: string;
  let tokenB: string;
  let tokenNoRole: string;
  const createdByA: string[] = [];

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    userA = await createTestUser('int-coll-a');
    await assignRole(userA.userId, 'mc-user');
    ({ accessToken: tokenA } = await getTestTokens(userA.username, userA.password));

    userB = await createTestUser('int-coll-b');
    await assignRole(userB.userId, 'mc-user');
    ({ accessToken: tokenB } = await getTestTokens(userB.username, userB.password));

    userNoRole = await createTestUser('int-coll-norole');
    ({ accessToken: tokenNoRole } = await getTestTokens(userNoRole.username, userNoRole.password));
  });

  afterAll(async () => {
    for (const id of createdByA) {
      await bff.delete(`/bff-api/collections/${id}`, auth(tokenA)).catch(() => {});
    }
    await deleteTestUser(userA?.userId);
    await deleteTestUser(userB?.userId);
    await deleteTestUser(userNoRole?.userId);
  });

  it('proxies authorized create/list/read/update/delete unchanged (US7-AC1)', async () => {
    const name = uniqueName();

    // CREATE → 201 with collectionId
    const created = await bff.post('/bff-api/collections', { name }, auth(tokenA));
    expect(created.status).toBe(201);
    const id = created.data.collectionId as string;
    expect(id).toBeTruthy();
    expect(created.data.name).toBe(name);
    createdByA.push(id);

    // LIST → includes it
    const list = await bff.get('/bff-api/collections', auth(tokenA));
    expect(list.status).toBe(200);
    expect(collectionsOf(list.data).some((c) => c.collectionId === id)).toBe(true);

    // READ → 200, name matches
    const read = await bff.get(`/bff-api/collections/${id}`, auth(tokenA));
    expect(read.status).toBe(200);
    expect(read.data.name).toBe(name);

    // UPDATE → 200
    const newName = uniqueName();
    const patched = await bff.patch(`/bff-api/collections/${id}`, { name: newName }, auth(tokenA));
    expect(patched.status).toBe(200);

    // DELETE → 204 (no body)
    const del = await bff.delete(`/bff-api/collections/${id}`, auth(tokenA));
    expect(del.status).toBe(204);
    createdByA.splice(createdByA.indexOf(id), 1);
  });

  it('rejects unauthenticated requests as 401 before any backend call (US7-AC2)', async () => {
    const getRes = await bff.get('/bff-api/collections');
    expect(getRes.status).toBe(401);
    expect(getRes.data.code).toBe('UNAUTHORIZED');

    // write: 401 AND no collection created (backend-state probe, no mock)
    const name = uniqueName();
    const postRes = await bff.post('/bff-api/collections', { name });
    expect(postRes.status).toBe(401);

    const probe = await bff.get('/bff-api/collections', auth(tokenA));
    expect(collectionsOf(probe.data).some((c) => c.name === name)).toBe(false);
  });

  it('rejects a caller lacking mc-user as 403 before any backend call (US7-AC3)', async () => {
    const getRes = await bff.get('/bff-api/collections', auth(tokenNoRole));
    expect(getRes.status).toBe(403);
    expect(getRes.data.code).toBe('FORBIDDEN');

    const name = uniqueName();
    const postRes = await bff.post('/bff-api/collections', { name }, auth(tokenNoRole));
    expect(postRes.status).toBe(403);

    const probe = await bff.get('/bff-api/collections', auth(tokenA));
    expect(collectionsOf(probe.data).some((c) => c.name === name)).toBe(false);
  });

  it('propagates the caller identity to the backend (US7-AC4)', async () => {
    // A collection created by user A is owned by A: it appears in A's list and
    // NOT in B's list — proving the JWT identity reached mc-service (ownerId).
    const name = uniqueName();
    const created = await bff.post('/bff-api/collections', { name }, auth(tokenA));
    expect(created.status).toBe(201);
    const id = created.data.collectionId as string;
    createdByA.push(id);

    const listA = await bff.get('/bff-api/collections', auth(tokenA));
    const listB = await bff.get('/bff-api/collections', auth(tokenB));
    expect(collectionsOf(listA.data).some((c) => c.collectionId === id)).toBe(true);
    expect(collectionsOf(listB.data).some((c) => c.collectionId === id)).toBe(false);
  });

  it('propagates backend domain errors unchanged (not-found, duplicate, validation) (US7-AC5)', async () => {
    // not-found: well-formed but nonexistent id → mc-service 404
    const notFound = await bff.get(`/bff-api/collections/${'a'.repeat(24)}`, auth(tokenA));
    expect(notFound.status).toBe(404);

    // duplicate name (per owner) → mc-service 409
    const name = uniqueName();
    const first = await bff.post('/bff-api/collections', { name }, auth(tokenA));
    expect(first.status).toBe(201);
    createdByA.push(first.data.collectionId);
    const dup = await bff.post('/bff-api/collections', { name }, auth(tokenA));
    expect(dup.status).toBe(409);

    // validation: empty name → mc-service 4xx (validation failure)
    const invalid = await bff.post('/bff-api/collections', { name: '' }, auth(tokenA));
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(invalid.status).toBeLessThan(500);
  });
});
