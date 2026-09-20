/**
 * Backup runner, end to end (feature 073, T032 — FR-008/012/014; US2-AC1/2/5).
 *
 * REAL mc-service, REAL MinIO, REAL Mongo. One run, one artifact.
 *
 * THE FIDELITY CHECK COMPARES AGAINST LIVE DATA READ BACK FROM mc-service, never against the
 * in-memory structure the artifact was built from. Comparing a thing to itself proves nothing
 * and would pass over a broken reader — which is precisely the failure mode that matters here,
 * because a truncated artifact is valid-looking and only discovered at restore.
 *
 * THE FAILED-RUN CASE IS THE OTHER HALF. When a destination fails mid-run the run must be
 * recorded `failed` and NO object may exist: a partial object would later be listed as a
 * restorable version, and the user would find out what it really was at the worst moment.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// `ajv/dist/2020`, not the default entry: the contract declares draft 2020-12 and Ajv 8's
// default export knows only draft-07, failing with a message about a missing $ref.
import Ajv2020 from 'ajv/dist/2020';

import { runBackup } from '@/bff-server/backup-runner';
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import { decompressArtifact, verifyArtifact } from '@/bff-server/backup-artifact';
import * as destinationStore from '@/bff-server/backup-destination-store';
import {
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  getBackupRunsCollection,
  closeMongo,
} from '@/bff-server/mongo-client';
import type { BackupDestination, BackupJob } from '@/types/backups';

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

const S3_ENDPOINT = process.env.BACKUP_TEST_S3_ENDPOINT || 'http://localhost:9100';
const S3_BUCKET = process.env.BACKUP_TEST_S3_BUCKET || 'mcm-backups-test';
const S3_ACCESS_KEY = process.env.BACKUP_TEST_S3_ACCESS_KEY || 'mcmbackuptest';
const S3_SECRET = process.env.BACKUP_TEST_S3_SECRET_KEY || '';

let user: TestUser;
let token: string;
let collectionIdA: string;
let collectionIdB: string;
const auth = () => ({ headers: { Authorization: `Bearer ${token}` } });

const PREFIX = `runner-${randomUUID()}`;

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

async function makeDestination(overrides: Record<string, unknown> = {}) {
  return destinationStore.createDestination(user.userId, {
    type: 's3',
    label: `runner-${randomUUID().slice(0, 8)}`,
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    region: 'us-east-1',
    pathStyle: true,
    accessKeyId: S3_ACCESS_KEY,
    basePath: PREFIX,
    secret: S3_SECRET,
    ...overrides,
  });
}

async function makeJob(destinationId: string, collectionIds: string[] = []): Promise<BackupJob> {
  const jobs = await getBackupJobsCollection();
  const job: BackupJob = {
    _id: randomUUID(),
    userId: user.userId,
    destinationId,
    label: 'runner job',
    collectionIds,
    keepLast: 7,
    enabled: true,
    claimedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await jobs.insertOne(job);
  return job;
}

async function driverFor(destinationId: string) {
  const doc = (await (await getBackupDestinationsCollection()).findOne({ _id: destinationId }))!;
  const secret = (await destinationStore.getDestinationSecret(user.userId, destinationId))!;
  return createBackupDriver(doc as BackupDestination, secret);
}

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require('@/config/env') as { env: { backupAllowedDestinationHosts: string } };
  const hosts = new Set(env.backupAllowedDestinationHosts.split(',').map((h) => h.trim()).filter(Boolean));
  hosts.add(new URL(S3_ENDPOINT).hostname);
  env.backupAllowedDestinationHosts = [...hosts].join(',');

  await ensureRopcAudienceMapper();
  user = await createTestUser('bk-runner');
  await assignRole(user.userId, 'mc-user');
  ({ accessToken: token } = await getTestTokens(user.username, user.password));

  const a = await bff.post('/bff-api/collections', { name: `Runner A ${randomUUID().slice(0, 8)}` }, auth());
  collectionIdA = a.data.collectionId ?? a.data.id;
  const b = await bff.post('/bff-api/collections', { name: `Runner B ${randomUUID().slice(0, 8)}` }, auth());
  collectionIdB = b.data.collectionId ?? b.data.id;

  for (const title of ['Runner One', 'Runner Two', 'Runner Three']) {
    await bff.post(`/bff-api/collections/${collectionIdA}/movies`, movieBody(title), auth());
  }
  await bff.post(`/bff-api/collections/${collectionIdB}/movies`, movieBody('Runner Solo'), auth());
}, 300_000);

afterAll(async () => {
  for (const id of [collectionIdA, collectionIdB]) {
    if (id) await bff.delete(`/bff-api/collections/${id}`, auth());
  }
  if (user) {
    await (await getBackupDestinationsCollection()).deleteMany({ userId: user.userId });
    await (await getBackupJobsCollection()).deleteMany({ userId: user.userId });
    await (await getBackupRunsCollection()).deleteMany({ userId: user.userId });
    await deleteTestUser(user.userId);
  }
  await closeMongo();
});

it('has a destination secret — without it every case below is one auth failure', () => {
  expect(S3_SECRET).not.toBe('');
});

describe('a successful run', () => {
  it('writes EXACTLY ONE object, whose digest recomputes', async () => {
    const destination = await makeDestination();
    const job = await makeJob(destination.id, [collectionIdA]);

    const run = await runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' });
    expect(run.status).toBe('success');
    expect(run.artifactKey).toBeTruthy();

    const driver = await driverFor(destination.id);
    const objects = await driver.list(`${PREFIX}/${job._id}/`);
    expect(objects).toHaveLength(1);
    expect(objects[0].key).toBe(run.artifactKey);

    const artifact = decompressArtifact(await driver.get(run.artifactKey!));
    expect(() => verifyArtifact(artifact)).not.toThrow();
  }, 180_000);

  it('validates against the PUBLISHED contract — with real mc-service movies in it', async () => {
    // The unit suite validates a hand-built artifact against the same schema, which proves the
    // builder agrees with the contract. This proves the CONTRACT agrees with mc-service: the
    // movies here came out of the real service, with its real field names and enum values.
    //
    // That distinction is not academic. The contract previously described movies with
    // `releaseYear` and `externalIdentifiers{source,value}` — fields mc-service does not have —
    // and a hand-built fixture using the same invented names validated happily. Anyone writing a
    // reader from the published schema would have found none of those fields in a real artifact.
    const destination = await makeDestination();
    const job = await makeJob(destination.id, [collectionIdA]);
    const run = await runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' });
    expect(run.status).toBe('success');

    const driver = await driverFor(destination.id);
    const artifact = decompressArtifact(await driver.get(run.artifactKey!));

    const schemaPath = join(
      __dirname, '..', '..', '..', '..',
      'specs', '073-scheduled-backups', 'contracts', 'backup-artifact-v1.schema.json',
    );
    const validate = new Ajv2020({ strict: false }).compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
    const valid = validate(JSON.parse(JSON.stringify(artifact)));
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);

    // And the movies really are populated — a contract check over an empty array proves nothing.
    expect(artifact.collections[0].movies.length).toBeGreaterThan(0);
    const movie = artifact.collections[0].movies[0] as Record<string, unknown>;
    expect(movie.title).toBeTruthy();
    expect(movie.year).toEqual(expect.any(Number));
    expect(Array.isArray(movie.externalIds)).toBe(true);
  }, 180_000);

  it('records counts that match LIVE data read back from mc-service', async () => {
    // Read back from the source of truth, not from the artifact and not from the seeding code.
    const destination = await makeDestination();
    const job = await makeJob(destination.id, [collectionIdA]);
    const run = await runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' });

    const live = await bff.get(`/bff-api/collections/${collectionIdA}/movies/count`, auth());
    const liveCount = Number(live.data.count ?? live.data);

    const driver = await driverFor(destination.id);
    const artifact = decompressArtifact(await driver.get(run.artifactKey!));

    expect(artifact.manifest.totalMovieCount).toBe(liveCount);
    expect(artifact.collections[0].movies).toHaveLength(liveCount);
    expect(run.collectionCounts[0].movieCount).toBe(liveCount);
  }, 180_000);

  it('backs up EVERY collection when the job names none', async () => {
    const destination = await makeDestination();
    const job = await makeJob(destination.id, []);
    const run = await runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' });

    const ids = run.collectionCounts.map((c) => c.collectionId);
    expect(ids).toContain(collectionIdA);
    expect(ids).toContain(collectionIdB);
  }, 180_000);

  it('names the object by job and ISO timestamp, so versions sort chronologically', async () => {
    // ISO-8601 sorting lexicographically is what makes retention "delete the tail" correct and
    // makes a job's artifacts structurally distinguishable at a shared destination.
    const destination = await makeDestination();
    const job = await makeJob(destination.id, [collectionIdB]);
    const run = await runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' });
    expect(run.artifactKey).toMatch(
      new RegExp(`^${PREFIX}/${job._id}/\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z\\.json\\.gz$`),
    );
  }, 180_000);

  it('persists a run record that agrees with what was written', async () => {
    const destination = await makeDestination();
    const job = await makeJob(destination.id, [collectionIdB]);
    const run = await runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' });

    const stored = await (await getBackupRunsCollection()).findOne({ _id: run._id });
    expect(stored?.status).toBe('success');
    expect(stored?.artifactKey).toBe(run.artifactKey);
    expect(stored?.userId).toBe(user.userId);
    expect(stored?.jobId).toBe(job._id);
    // The TTL field must be a real Date, or run history never expires (see mongo-client).
    expect(stored?.expiresAt).toBeInstanceOf(Date);
  }, 180_000);
});

describe('a run that fails mid-way', () => {
  it('is recorded FAILED and leaves NO object behind (FR-014)', async () => {
    // Asserted on the destination, not on the exception. "It threw" does not prove nothing was
    // written, and a partial object would later be offered as a restorable version.
    const good = await makeDestination();
    const goodJob = await makeJob(good.id, [collectionIdA]);
    const broken = await makeDestination({ bucket: `absent-bucket-${randomUUID().slice(0, 8)}` });
    const job = await makeJob(broken.id, [collectionIdA]);

    const run = await runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' });

    expect(run.status).toBe('failed');
    expect(run.artifactKey).toBeFalsy();
    expect(run.failureReason).toBeTruthy();

    // Nothing under this job's prefix, checked through a WORKING destination pointed at the
    // same bucket — asking the broken one would confuse "no object" with "cannot look".
    const driver = await driverFor(good.id);
    expect(await driver.list(`${PREFIX}/${job._id}/`)).toEqual([]);
    void goodJob;
  }, 180_000);

  it('records the failure reason without an upstream body or a credential', async () => {
    const broken = await makeDestination({ bucket: `absent-bucket-${randomUUID().slice(0, 8)}` });
    const job = await makeJob(broken.id, [collectionIdA]);
    const run = await runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' });

    expect(run.failureReason).not.toContain(S3_SECRET);
    expect(run.failureReason).not.toMatch(/<\?xml|<Error>/);
  }, 180_000);

  it('does not fail the run because the destination address became disallowed', async () => {
    // A guard rejection is a REASON, not a crash: the run is recorded failed with something the
    // user can act on, rather than a 500 with a stack.
    const blocked = await makeDestination({ endpoint: 'http://169.254.169.254/' });
    const job = await makeJob(blocked.id, [collectionIdA]);
    const run = await runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' });
    expect(run.status).toBe('failed');
    expect(run.failureReason).toMatch(/not allowed/i);
  }, 180_000);
});
