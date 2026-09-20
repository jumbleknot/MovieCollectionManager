/**
 * Size ceiling (feature 073, T030 — FR-015; US2-AC6).
 *
 * THE ASSERTION THAT MATTERS IS THE OBJECT COUNT AT THE DESTINATION, not that the call threw.
 * "It threw" does not prove nothing was written, and a truncated artifact that looks complete
 * is precisely the failure this ceiling exists to prevent — it would be listed as a restorable
 * version and discovered at restore time.
 *
 * The ceiling exists because the runner deliberately does NOT stream: the artifact is built in
 * memory and written as one object so a failure cannot leave a partial. That choice has a
 * memory cost, and this is where the cost is made explicit and loud rather than left to be
 * discovered as an OOM.
 *
 * Both units are checked independently: MANY SMALL movies (count-bound) and FEW LARGE ones
 * (bytes-bound). A ceiling that only ever fires on one of them is half a ceiling.
 */
import { randomUUID } from 'node:crypto';

import { runBackup } from '@/bff-server/backup-runner';
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
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
  describeBackupTargets,
  itBackupTargets,
  assertBackupTargetsPresent,
} from './helpers/backup-targets';
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

const PREFIX = `ceiling-${randomUUID()}`;
const SEEDED_MOVIES = 20;

let user: TestUser;
let token: string;
let collectionId: string;
const auth = () => ({ headers: { Authorization: `Bearer ${token}` } });

const movieBody = (title: string, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});

async function makeDestination() {
  return destinationStore.createDestination(user.userId, {
    type: 's3',
    label: `ceiling-${randomUUID().slice(0, 8)}`,
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    region: 'us-east-1',
    pathStyle: true,
    accessKeyId: S3_ACCESS_KEY,
    basePath: PREFIX,
    secret: S3_SECRET,
  });
}

async function makeJob(destinationId: string): Promise<BackupJob> {
  const jobs = await getBackupJobsCollection();
  const job: BackupJob = {
    _id: randomUUID(),
    userId: user.userId,
    destinationId,
    label: 'ceiling job',
    collectionIds: [collectionId],
    keepLast: 7,
    enabled: true,
    claimedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await jobs.insertOne(job);
  return job;
}

async function objectsUnder(destinationId: string, jobId: string) {
  const doc = (await (await getBackupDestinationsCollection()).findOne({ _id: destinationId }))!;
  const secret = (await destinationStore.getDestinationSecret(user.userId, destinationId))!;
  const driver = await createBackupDriver(doc as BackupDestination, secret);
  return driver.list(`${PREFIX}/${jobId}/`);
}

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require('@/config/env') as {
    env: { backupAllowedDestinationHosts: string; backupMaxMovies: number; backupMaxUncompressedBytes: number };
  };
  const hosts = new Set(env.backupAllowedDestinationHosts.split(',').map((h) => h.trim()).filter(Boolean));
  hosts.add(new URL(S3_ENDPOINT).hostname);
  env.backupAllowedDestinationHosts = [...hosts].join(',');

  await ensureRopcAudienceMapper();
  user = await createTestUser('bk-ceiling');
  await assignRole(user.userId, 'mc-user');
  ({ accessToken: token } = await getTestTokens(user.username, user.password));

  const created = await bff.post('/bff-api/collections', { name: `Ceiling ${randomUUID().slice(0, 8)}` }, auth());
  collectionId = created.data.collectionId ?? created.data.id;
  for (let i = 0; i < SEEDED_MOVIES; i += 1) {
    await bff.post(`/bff-api/collections/${collectionId}/movies`, movieBody(`Ceiling ${i}`), auth());
  }
}, 300_000);

afterAll(async () => {
  if (collectionId) await bff.delete(`/bff-api/collections/${collectionId}`, auth());
  if (user) {
    await (await getBackupDestinationsCollection()).deleteMany({ userId: user.userId });
    await (await getBackupJobsCollection()).deleteMany({ userId: user.userId });
    await (await getBackupRunsCollection()).deleteMany({ userId: user.userId });
    await deleteTestUser(user.userId);
  }
  await closeMongo();
});

// The ceilings are read from `env` at use, so a test can lower them without a process restart.
// Restored after each case so one case's ceiling cannot silently govern the next.
function withCeilings<T>(ceilings: { movies?: number; bytes?: number }, body: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require('@/config/env') as { env: { backupMaxMovies: number; backupMaxUncompressedBytes: number } };
  const previous = { movies: env.backupMaxMovies, bytes: env.backupMaxUncompressedBytes };
  if (ceilings.movies !== undefined) env.backupMaxMovies = ceilings.movies;
  if (ceilings.bytes !== undefined) env.backupMaxUncompressedBytes = ceilings.bytes;
  return body().finally(() => {
    env.backupMaxMovies = previous.movies;
    env.backupMaxUncompressedBytes = previous.bytes;
  });
}

itBackupTargets('has the backup destinations up — otherwise every case below is one failure', () => {
  assertBackupTargetsPresent();
});

describeBackupTargets('the count ceiling', () => {
  it('fails the run and writes NOTHING when the movie count exceeds it', async () => {
    const destination = await makeDestination();
    const job = await makeJob(destination.id);

    const run = await withCeilings({ movies: 5 }, () =>
      runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' }),
    );

    expect(run.status).toBe('failed');
    // THE assertion: zero objects at the destination. Not "it threw".
    expect(await objectsUnder(destination.id, job._id)).toEqual([]);
  }, 180_000);

  it('names BOTH the ceiling and the measured value, so the operator knows what to raise', async () => {
    const destination = await makeDestination();
    const job = await makeJob(destination.id);

    const run = await withCeilings({ movies: 5 }, () =>
      runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' }),
    );

    expect(run.failureReason).toContain('5');
    expect(run.failureReason).toContain(String(SEEDED_MOVIES));
  }, 180_000);
});

describeBackupTargets('the byte ceiling', () => {
  it('fails the run and writes NOTHING when the uncompressed size exceeds it', async () => {
    // Checked independently of the count: a collection of a few very large records is under
    // any count ceiling and can still be far too big to hold.
    const destination = await makeDestination();
    const job = await makeJob(destination.id);

    const run = await withCeilings({ movies: 100_000, bytes: 512 }, () =>
      runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' }),
    );

    expect(run.status).toBe('failed');
    expect(run.failureReason).toMatch(/size|bytes/i);
    expect(await objectsUnder(destination.id, job._id)).toEqual([]);
  }, 180_000);
});

describeBackupTargets('an ordinary run is unaffected', () => {
  it('succeeds and writes one object when both ceilings are comfortable', async () => {
    // The control. Without it, a ceiling that rejected EVERYTHING would pass both cases above.
    const destination = await makeDestination();
    const job = await makeJob(destination.id);

    const run = await withCeilings({ movies: 100_000, bytes: 64 * 1024 * 1024 }, () =>
      runBackup({ userId: user.userId, jwt: token, job, trigger: 'manual' }),
    );

    expect(run.status).toBe('success');
    expect(await objectsUnder(destination.id, job._id)).toHaveLength(1);
  }, 180_000);
});
