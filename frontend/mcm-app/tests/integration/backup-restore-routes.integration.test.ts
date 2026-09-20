/**
 * Version, restore and download routes (feature 073, T045 — FR-028/029/031/032).
 *
 * Over HTTP against the real BFF, with a real destination and a real backup.
 *
 * WHAT THESE ROUTES MUST NOT BE is a way around the checks that sit behind them. The restore
 * handler holds no validation of its own — it calls `restoreFromBytes`, which verifies before
 * writing — and the download handle is NOT a capability: the key is a job id and a timestamp,
 * so it is guessable, and ownership is therefore re-established from the session on every
 * request rather than inferred from possession of the key.
 */
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

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

const S3_ENDPOINT = process.env.BACKUP_TEST_S3_INTERNAL_ENDPOINT || 'http://mcm-backup-test-minio:9000';
const S3_BUCKET = process.env.BACKUP_TEST_S3_BUCKET || 'mcm-backups-test';
const S3_ACCESS_KEY = process.env.BACKUP_TEST_S3_ACCESS_KEY || 'mcmbackuptest';
const S3_SECRET = process.env.BACKUP_TEST_S3_SECRET_KEY || '';

let userA: TestUser;
let userB: TestUser;
let tokenA: string;
let tokenB: string;
let jobId: string;
let collectionId: string;
let versionKey: string;

const authA = () => ({ headers: { Authorization: `Bearer ${tokenA}` } });
const authB = () => ({ headers: { Authorization: `Bearer ${tokenB}` } });

beforeAll(async () => {
  await ensureRopcAudienceMapper();
  userA = await createTestUser('bk-rroutes-a');
  await assignRole(userA.userId, 'mc-user');
  ({ accessToken: tokenA } = await getTestTokens(userA.username, userA.password));
  userB = await createTestUser('bk-rroutes-b');
  await assignRole(userB.userId, 'mc-user');
  ({ accessToken: tokenB } = await getTestTokens(userB.username, userB.password));

  const collection = await bff.post('/bff-api/collections', { name: `RR ${randomUUID().slice(0, 8)}` }, authA());
  collectionId = collection.data.collectionId ?? collection.data.id;
  await bff.post(
    `/bff-api/collections/${collectionId}/movies`,
    {
      title: 'RR Movie', year: 2015, contentType: 'Movie', language: 'English',
      owned: true, ripped: false, childrens: false, ownedMedia: [], ripQuality: [],
      genres: ['Action'], rated: 'R', directors: [], actors: [], tags: [],
      movieSet: null, originalTitle: null, releaseDate: null, outline: null, plot: null,
      runtime: null, externalIds: [],
    },
    authA(),
  );

  const destination = await destinationStore.createDestination(userA.userId, {
    type: 's3',
    label: `rr-${randomUUID().slice(0, 8)}`,
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    region: 'us-east-1',
    pathStyle: true,
    accessKeyId: S3_ACCESS_KEY,
    basePath: `rr-${randomUUID().slice(0, 8)}`,
    secret: S3_SECRET,
  });

  const job = await bff.post(
    JOBS,
    { destinationId: destination.id, label: 'rr job', collectionIds: [collectionId], keepLast: 7, enabled: true },
    authA(),
  );
  jobId = job.data.id;

  const run = await bff.post(`${JOBS}/${jobId}/run`, {}, authA());
  expect(run.status).toBe(202);
  expect(run.data.status).toBe('success');

  const versions = await bff.get(`${JOBS}/${jobId}/versions`, authA());
  versionKey = versions.data[0].key;
}, 300_000);

afterAll(async () => {
  const res = await bff.get('/bff-api/collections', authA());
  for (const c of (Array.isArray(res.data) ? res.data : []) as Array<{ collectionId?: string; id?: string }>) {
    const id = c.collectionId ?? c.id;
    if (id) await bff.delete(`/bff-api/collections/${id}`, authA());
  }
  const users = { $in: [userA?.userId, userB?.userId].filter(Boolean) };
  await (await getBackupDestinationsCollection()).deleteMany({ userId: users });
  await (await getBackupJobsCollection()).deleteMany({ userId: users });
  await (await getBackupRunsCollection()).deleteMany({ userId: users });
  if (userA) await deleteTestUser(userA.userId);
  if (userB) await deleteTestUser(userB.userId);
  await closeMongo();
}, 300_000);

describe('versions', () => {
  it('lists the version the run wrote, marked usable', async () => {
    const res = await bff.get(`${JOBS}/${jobId}/versions`, authA());
    expect(res.status).toBe(200);
    expect(res.data).toHaveLength(1);
    expect(res.data[0].usable).toBe(true);
    expect(res.data[0].sizeBytes).toBeGreaterThan(0);
  });

  it('answers 404 for another user’s job', async () => {
    expect((await bff.get(`${JOBS}/${jobId}/versions`, authB())).status).toBe(404);
  });
});

describe('download', () => {
  it('streams bytes that gunzip into a valid artifact', async () => {
    // The point of FR-028: a user must be able to read their own backup WITHOUT this system.
    // If these bytes do not gunzip into plain JSON outside the app, that promise is not kept.
    const res = await bff.get(
      `${JOBS}/${jobId}/download?key=${encodeURIComponent(versionKey)}`,
      { ...authA(), responseType: 'arraybuffer' },
    );
    expect(res.status).toBe(200);
    expect(String(res.headers['content-disposition'])).toContain('attachment');

    const parsed = JSON.parse(gunzipSync(Buffer.from(res.data as ArrayBuffer)).toString('utf8'));
    expect(parsed.manifest.formatVersion).toBe(1);
    expect(parsed.collections[0].movies).toHaveLength(1);
  }, 60_000);

  it('refuses another user’s key — possession of a key is NOT authorisation', async () => {
    const res = await bff.get(`${JOBS}/${jobId}/download?key=${encodeURIComponent(versionKey)}`, authB());
    expect(res.status).toBe(404);
  });

  it('refuses a key outside this job’s prefix', async () => {
    // The key is client-supplied and guessable, so it is confined rather than trusted.
    const res = await bff.get(
      `${JOBS}/${jobId}/download?key=${encodeURIComponent('some-other-prefix/secret.json.gz')}`,
      authA(),
    );
    expect(res.status).toBe(404);
  });

  it('refuses a traversal out of the prefix', async () => {
    const traversal = `${versionKey.split('/').slice(0, 2).join('/')}/../../elsewhere.json.gz`;
    const res = await bff.get(`${JOBS}/${jobId}/download?key=${encodeURIComponent(traversal)}`, authA());
    expect(res.status).toBe(404);
  });
});

describe('restore', () => {
  it('restores into NEW collections and reports what it did', async () => {
    const before = (await bff.get('/bff-api/collections', authA())).data.length;
    const res = await bff.post(`${JOBS}/${jobId}/restore`, { key: versionKey }, authA());
    expect(res.status).toBe(200);
    expect(res.data.createdCollectionIds).toHaveLength(1);
    expect(res.data.movieCount).toBe(1);
    expect(res.data.partial).toBe(false);

    const after = (await bff.get('/bff-api/collections', authA())).data.length;
    expect(after).toBe(before + 1);
  }, 120_000);

  it('does not touch the original collection', async () => {
    const original = await bff.get(`/bff-api/collections/${collectionId}/movies/count`, authA());
    expect(Number(original.data.count ?? original.data)).toBe(1);
  });

  it('answers 404 for another user’s job rather than restoring into their account', async () => {
    expect((await bff.post(`${JOBS}/${jobId}/restore`, { key: versionKey }, authB())).status).toBe(404);
  });

  it('answers 404 for a key outside the job’s prefix', async () => {
    const res = await bff.post(`${JOBS}/${jobId}/restore`, { key: 'elsewhere/x.json.gz' }, authA());
    expect(res.status).toBe(404);
  });

  it('requires a key', async () => {
    expect((await bff.post(`${JOBS}/${jobId}/restore`, {}, authA())).status).toBe(400);
  });
});
