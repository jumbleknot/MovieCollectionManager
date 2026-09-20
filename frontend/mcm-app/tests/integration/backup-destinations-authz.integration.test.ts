/**
 * Backup destination route authorization (feature 073, T020 — FR-034 / SC-010 / US1-AC5).
 *
 * TWO REAL USERS against the real stack: real Keycloak tokens, the real BFF over HTTP, real
 * Mongo. User B asks for every one of user A's destination routes and must receive 404 — NOT
 * 403. A 403 confirms the resource exists, and that confirmation is itself the leak: it turns
 * "guess an id" into an existence oracle.
 *
 * THE TRAP THIS SUITE IS BUILT AROUND. "Not found" is both the expected result and the failure
 * mode. Against a BFF where these routes do not exist at all, every 404 assertion passes — the
 * suite reports success over a feature that was never built. So the FIRST test is a positive
 * control: user A's own happy path must return 200. Every 404 case below is meaningful only
 * because that one passes, and if it is ever seen to skip or fail, nothing else here can be
 * believed.
 *
 * Note also what is absent by design: no route anywhere takes a userId from a path, query or
 * body. The OpenAPI contract deliberately contains no such parameter, so there is nothing to
 * spoof; the spoofing attempts below assert that adding one changes nothing.
 */
import { createBffClient } from './helpers/bff-test-server';
import {
  createTestUser,
  deleteTestUser,
  getTestTokens,
  assignRole,
  ensureRopcAudienceMapper,
  type TestUser,
} from './helpers/keycloak-test-client';
import { getBackupDestinationsCollection, closeMongo } from '@/bff-server/mongo-client';

const bff = createBffClient();
const BASE = '/bff-api/backups/destinations';

let userA: TestUser;
let userB: TestUser;
let tokenA: string;
let tokenB: string;
let destinationIdA: string;

const authA = () => ({ headers: { Authorization: `Bearer ${tokenA}` } });
const authB = () => ({ headers: { Authorization: `Bearer ${tokenB}` } });

// The REAL test MinIO, addressed the way the BFF CONTAINER reaches it. A placeholder like
// `https://s3.example.com` is refused on save with a 400, and correctly so: the guard RESOLVES
// the host, and a name that does not resolve is not safe, it is unknown. Using a placeholder
// here made the positive control fail for a reason that had nothing to do with authorization.
const S3_ENDPOINT = process.env.BACKUP_TEST_S3_INTERNAL_ENDPOINT || 'http://mcm-bff-backup-minio:9000';

const s3Body = (label: string) => ({
  type: 's3',
  label,
  endpoint: S3_ENDPOINT,
  bucket: 'backups',
  region: 'us-east-1',
  pathStyle: true,
  accessKeyId: 'AKIDEXAMPLE',
  secret: 'the-secret-access-key',
});

beforeAll(async () => {
  await ensureRopcAudienceMapper();
  userA = await createTestUser('bk-authz-a');
  await assignRole(userA.userId, 'mc-user');
  ({ accessToken: tokenA } = await getTestTokens(userA.username, userA.password));
  userB = await createTestUser('bk-authz-b');
  await assignRole(userB.userId, 'mc-user');
  ({ accessToken: tokenB } = await getTestTokens(userB.username, userB.password));
}, 60_000);

afterAll(async () => {
  const collection = await getBackupDestinationsCollection();
  await collection.deleteMany({ userId: { $in: [userA?.userId, userB?.userId].filter(Boolean) } });
  if (userA) await deleteTestUser(userA.userId);
  if (userB) await deleteTestUser(userB.userId);
  await closeMongo();
});

describe('the positive control — without this, every 404 below is meaningless', () => {
  it('user A can create and then read their OWN destination (200)', async () => {
    const created = await bff.post(BASE, s3Body(`authz-${Date.now()}`), authA());
    expect(created.status).toBe(201);
    expect(created.data.id).toBeTruthy();
    destinationIdA = created.data.id;

    const read = await bff.get(`${BASE}/${destinationIdA}`, authA());
    expect(read.status).toBe(200);
    expect(read.data.id).toBe(destinationIdA);
  });

  it('a created destination never carries a secret back', async () => {
    const read = await bff.get(`${BASE}/${destinationIdA}`, authA());
    expect(JSON.stringify(read.data)).not.toContain('secretEnc');
    expect(JSON.stringify(read.data)).not.toContain('the-secret-access-key');
  });
});

describe('user B gets 404, never 403 (FR-034)', () => {
  it('GET of A’s destination → 404', async () => {
    const res = await bff.get(`${BASE}/${destinationIdA}`, authB());
    expect(res.status).toBe(404);
  });

  it('PATCH of A’s destination → 404, and A’s data is unchanged', async () => {
    const res = await bff.patch(`${BASE}/${destinationIdA}`, { label: 'hijacked' }, authB());
    expect(res.status).toBe(404);
    const stillA = await bff.get(`${BASE}/${destinationIdA}`, authA());
    expect(stillA.data.label).not.toBe('hijacked');
  });

  it('DELETE of A’s destination → 404, and it still exists', async () => {
    const res = await bff.delete(`${BASE}/${destinationIdA}`, authB());
    expect(res.status).toBe(404);
    expect((await bff.get(`${BASE}/${destinationIdA}`, authA())).status).toBe(200);
  });

  it('LIST returns only B’s own destinations, which is none', async () => {
    const res = await bff.get(BASE, authB());
    expect(res.status).toBe(200);
    expect(res.data).toEqual([]);
  });

  it('an unknown id gets the SAME 404 as a foreign one — no existence oracle', async () => {
    // If a foreign id answered differently from a nonexistent one, the difference would be the
    // leak, whatever the status codes happened to be.
    const foreign = await bff.get(`${BASE}/${destinationIdA}`, authB());
    const unknown = await bff.get(`${BASE}/00000000-0000-4000-8000-000000000000`, authB());
    expect(foreign.status).toBe(unknown.status);
    expect(foreign.status).toBe(404);
  });
});

describe('no route accepts a userId from the request', () => {
  it('a spoofed body userId is REJECTED outright, not quietly ignored', async () => {
    // The body schema is `.strict()`, so an unknown key is a 400 rather than a field that is
    // dropped. Both are safe — the store never reads a userId from a body — but rejecting
    // makes the attempt VISIBLE, in the response and in the logs, instead of letting a client
    // believe it set something it did not. That is the difference between a control that is
    // enforced and one that merely happens to hold.
    const before = await (await getBackupDestinationsCollection()).countDocuments({ userId: userA.userId });
    const res = await bff.post(
      BASE,
      { ...s3Body(`spoof-${Date.now()}`), userId: userA.userId, _id: 'chosen-by-caller' },
      authB(),
    );
    expect(res.status).toBe(400);
    const after = await (await getBackupDestinationsCollection()).countDocuments({ userId: userA.userId });
    expect(after).toBe(before);
  });

  it('the same body WITHOUT the spoofed keys becomes B\u2019s own destination', async () => {
    // The control for the case above: it must be the spoofed keys that are refused, not the
    // request shape, or the 400 would prove nothing about userId handling.
    const res = await bff.post(BASE, s3Body(`clean-${Date.now()}`), authB());
    expect(res.status).toBe(201);
    const doc = await (await getBackupDestinationsCollection()).findOne({ _id: res.data.id });
    expect(doc?.userId).toBe(userB.userId);
  });

  it('a spoofed query userId does not widen a list', async () => {
    const res = await bff.get(`${BASE}?userId=${encodeURIComponent(userA.userId)}`, authB());
    expect(res.status).toBe(200);
    expect(res.data.every((d: { id: string }) => d.id !== destinationIdA)).toBe(true);
  });
});

describe('authentication is required at all', () => {
  it('rejects an unauthenticated list', async () => {
    const res = await bff.get(BASE);
    expect([401, 403]).toContain(res.status);
  });

  it('rejects an unauthenticated create', async () => {
    const res = await bff.post(BASE, s3Body(`anon-${Date.now()}`));
    expect([401, 403]).toContain(res.status);
  });
});
