/**
 * Backup job routes — authorization and behaviour (feature 073, T037 — FR-007/012/013/034).
 *
 * TWO REAL USERS, real Keycloak, the real BFF over HTTP, a real destination and a real run.
 *
 * As in the destinations authz suite, the FIRST test is a positive control. Every 404
 * assertion below is satisfied by a BFF where these routes do not exist, so without a case
 * that proves the happy path works, "all green" would mean nothing. If the control is ever
 * seen failing or skipped, nothing else here can be believed.
 */
import { randomUUID } from 'node:crypto';

import * as destinationStore from '@/bff-server/backup-destination-store';
import {
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  getBackupRunsCollection,
  closeMongo,
} from '@/bff-server/mongo-client';

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
const JOBS = '/bff-api/backups/jobs';

// The BFF container reaches the test MinIO by compose service name, not on loopback.
const S3_ENDPOINT = process.env.BACKUP_TEST_S3_INTERNAL_ENDPOINT || 'http://mcm-backup-test-minio:9000';
const S3_BUCKET = process.env.BACKUP_TEST_S3_BUCKET || 'mcm-backups-test';
const S3_ACCESS_KEY = process.env.BACKUP_TEST_S3_ACCESS_KEY || 'mcmbackuptest';
const S3_SECRET = process.env.BACKUP_TEST_S3_SECRET_KEY || '';

let userA: TestUser;
let userB: TestUser;
let tokenA: string;
let tokenB: string;
let destinationA: string;
let destinationB: string;
let collectionA: string;
let jobA: string;

const authA = () => ({ headers: { Authorization: `Bearer ${tokenA}` } });
const authB = () => ({ headers: { Authorization: `Bearer ${tokenB}` } });

async function seedDestination(userId: string) {
  return destinationStore.createDestination(userId, {
    type: 's3',
    label: `jobs-${randomUUID().slice(0, 8)}`,
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    region: 'us-east-1',
    pathStyle: true,
    accessKeyId: S3_ACCESS_KEY,
    basePath: `jobs-authz-${randomUUID().slice(0, 8)}`,
    secret: S3_SECRET,
  });
}

beforeAll(async () => {
  await ensureRopcAudienceMapper();
  userA = await createTestUser('bk-jobs-a');
  await assignRole(userA.userId, 'mc-user');
  ({ accessToken: tokenA } = await getTestTokens(userA.username, userA.password));
  userB = await createTestUser('bk-jobs-b');
  await assignRole(userB.userId, 'mc-user');
  ({ accessToken: tokenB } = await getTestTokens(userB.username, userB.password));

  destinationA = (await seedDestination(userA.userId)).id;
  destinationB = (await seedDestination(userB.userId)).id;

  const created = await bff.post('/bff-api/collections', { name: `Jobs ${randomUUID().slice(0, 8)}` }, authA());
  collectionA = created.data.collectionId ?? created.data.id;
  await bff.post(
    `/bff-api/collections/${collectionA}/movies`,
    {
      title: 'Jobs Movie', year: 2015, contentType: 'Movie', language: 'English',
      owned: true, ripped: false, childrens: false, ownedMedia: [], ripQuality: [],
      genres: ['Action'], rated: 'R', directors: [], actors: [], tags: [],
      movieSet: null, originalTitle: null, releaseDate: null, outline: null, plot: null,
      runtime: null, externalIds: [],
    },
    authA(),
  );
}, 120_000);

afterAll(async () => {
  if (collectionA) await bff.delete(`/bff-api/collections/${collectionA}`, authA());
  const users = { $in: [userA?.userId, userB?.userId].filter(Boolean) };
  await (await getBackupDestinationsCollection()).deleteMany({ userId: users });
  await (await getBackupJobsCollection()).deleteMany({ userId: users });
  await (await getBackupRunsCollection()).deleteMany({ userId: users });
  if (userA) await deleteTestUser(userA.userId);
  if (userB) await deleteTestUser(userB.userId);
  await closeMongo();
});

describe('the positive control — without this, every 404 below is meaningless', () => {
  it('user A creates and reads their OWN job (201 then 200)', async () => {
    const created = await bff.post(
      JOBS,
      { destinationId: destinationA, label: 'nightly', collectionIds: [collectionA], keepLast: 7, enabled: true },
      authA(),
    );
    expect(created.status).toBe(201);
    jobA = created.data.id;

    const read = await bff.get(`${JOBS}/${jobA}`, authA());
    expect(read.status).toBe(200);
    expect(read.data.collectionIds).toEqual([collectionA]);
  });
});

describe('user B gets 404, never 403 (FR-034)', () => {
  it.each([
    ['GET', (id: string) => bff.get(`${JOBS}/${id}`, authB())],
    ['PATCH', (id: string) => bff.patch(`${JOBS}/${id}`, { label: 'hijacked' }, authB())],
    ['DELETE', (id: string) => bff.delete(`${JOBS}/${id}`, authB())],
    ['runs', (id: string) => bff.get(`${JOBS}/${id}/runs`, authB())],
    ['run now', (id: string) => bff.post(`${JOBS}/${id}/run`, {}, authB())],
  ])('%s of A’s job → 404', async (_label, call) => {
    const res = await call(jobA);
    expect(res.status).toBe(404);
  });

  it('A’s job is unchanged afterwards', async () => {
    const read = await bff.get(`${JOBS}/${jobA}`, authA());
    expect(read.status).toBe(200);
    expect(read.data.label).not.toBe('hijacked');
  });

  it('B cannot aim a job at A’s destination', async () => {
    // The payoff would be this server writing B's collection into storage A controls, using
    // A's stored credential — so the destination is checked against the CALLER, never the body.
    const res = await bff.post(
      JOBS,
      { destinationId: destinationA, label: 'borrowed', collectionIds: [], keepLast: 7, enabled: true },
      authB(),
    );
    expect(res.status).toBe(400);
  });

  it('B’s list does not contain A’s job', async () => {
    const res = await bff.get(JOBS, authB());
    expect(res.status).toBe(200);
    expect(res.data.every((j: { id: string }) => j.id !== jobA)).toBe(true);
  });
});

describe('validation', () => {
  it('rejects keepLast outside 1..365', async () => {
    const res = await bff.post(
      JOBS,
      { destinationId: destinationA, label: 'bad', collectionIds: [], keepLast: 0, enabled: true },
      authA(),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an unknown time zone rather than storing a job that can never be scheduled', async () => {
    // Accepted here, it becomes a job that throws on every schedule computation for ever, and
    // the error surfaces nowhere near the form that took it.
    const res = await bff.post(
      JOBS,
      {
        destinationId: destinationA,
        label: 'bad-zone',
        collectionIds: [],
        keepLast: 7,
        enabled: true,
        schedule: { frequency: 'daily', hour: 3, minute: 0, timeZone: 'Mars/Olympus_Mons' },
      },
      authA(),
    );
    expect(res.status).toBe(400);
  });
});

describe('back up now', () => {
  it('runs, reports a summary, and records it in history (US2-AC1)', async () => {
    const res = await bff.post(`${JOBS}/${jobA}/run`, {}, authA());
    expect(res.status).toBe(202);
    expect(res.data.status).toBe('success');
    expect(res.data.movieCount).toBeGreaterThan(0);

    const runs = await bff.get(`${JOBS}/${jobA}/runs`, authA());
    expect(runs.status).toBe(200);
    expect(runs.data[0].runId).toBe(res.data.runId);
  }, 120_000);

  it('shows the newest outcome on the job itself, without a second query', async () => {
    const read = await bff.get(`${JOBS}/${jobA}`, authA());
    expect(read.data.lastRun?.status).toBe('success');
  });

  it('refuses a genuinely CONCURRENT second run with 409 (FR-013)', async () => {
    // Issued together. A sequential pair would prove only that a finished run frees the slot.
    const [first, second] = await Promise.all([
      bff.post(`${JOBS}/${jobA}/run`, {}, authA()),
      bff.post(`${JOBS}/${jobA}/run`, {}, authA()),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([202, 409]);
  }, 120_000);
});

describe('authentication is required', () => {
  it.each([
    ['list', () => bff.get(JOBS)],
    ['create', () => bff.post(JOBS, {})],
    ['run', () => bff.post(`${JOBS}/${jobA}/run`, {})],
  ])('rejects an unauthenticated %s', async (_label, call) => {
    const res = await call();
    expect([401, 403]).toContain(res.status);
  });
});
