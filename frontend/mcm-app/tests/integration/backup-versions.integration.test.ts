/**
 * Version listing (feature 073, T044 — FR-028; spec Edge Cases; US3-AC5).
 *
 * Lists the job's prefix AT THE DESTINATION directly, rather than from run history, so it
 * reflects WHAT IS ACTUALLY THERE — including objects this system did not write and versions
 * removed by someone else since. Run history records what this system believes it did; the
 * destination is the user's storage and is authoritative about its own contents.
 *
 * THE CASE THAT IS EASY TO MISS: an object that is PRESENT but zero-length or unreadable must
 * be listed as unusable, not offered for restore. A version list that offers a corrupt object
 * as restorable sends the user to a failure at the worst possible moment — and hiding it
 * entirely would be its own lie, because the object really is there and its space really is
 * being used.
 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { buildArtifact, compressArtifact } from '@/bff-server/backup-artifact';
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import * as destinationStore from '@/bff-server/backup-destination-store';
import { listBackupVersions } from '@/bff-server/backup-version-lister';
import {
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  closeMongo,
} from '@/bff-server/mongo-client';
import type { BackupDestination, BackupJob } from '@/types/backups';

const S3_ENDPOINT = process.env.BACKUP_TEST_S3_ENDPOINT || 'http://localhost:9100';
const S3_BUCKET = process.env.BACKUP_TEST_S3_BUCKET || 'mcm-backups-test';
const S3_ACCESS_KEY = process.env.BACKUP_TEST_S3_ACCESS_KEY || 'mcmbackuptest';
const S3_SECRET = process.env.BACKUP_TEST_S3_SECRET_KEY || '';

const USER = `t044-${randomUUID()}`;
const PREFIX = `versions-${randomUUID().slice(0, 8)}`;

let destinationId: string;
let job: BackupJob;
let otherJob: BackupJob;

async function driver() {
  const doc = (await (await getBackupDestinationsCollection()).findOne({ _id: destinationId }))!;
  const secret = (await destinationStore.getDestinationSecret(USER, destinationId))!;
  return createBackupDriver(doc as BackupDestination, secret);
}

async function makeJob(): Promise<BackupJob> {
  const doc: BackupJob = {
    _id: randomUUID(),
    userId: USER,
    destinationId,
    label: 'versions job',
    collectionIds: [],
    keepLast: 7,
    enabled: true,
    claimedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await (await getBackupJobsCollection()).insertOne(doc);
  return doc;
}

const healthyBytes = (jobId: string) =>
  compressArtifact(buildArtifact(jobId, [{ id: 'c1', name: 'One', movies: [] }]));

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require('@/config/env') as { env: { backupAllowedDestinationHosts: string } };
  const hosts = new Set(env.backupAllowedDestinationHosts.split(',').map((h) => h.trim()).filter(Boolean));
  hosts.add(new URL(S3_ENDPOINT).hostname);
  env.backupAllowedDestinationHosts = [...hosts].join(',');

  destinationId = (
    await destinationStore.createDestination(USER, {
      type: 's3',
      label: `versions-${randomUUID().slice(0, 8)}`,
      endpoint: S3_ENDPOINT,
      bucket: S3_BUCKET,
      region: 'us-east-1',
      pathStyle: true,
      accessKeyId: S3_ACCESS_KEY,
      basePath: PREFIX,
      secret: S3_SECRET,
    })
  ).id;

  job = await makeJob();
  otherJob = await makeJob();

  const d = await driver();
  await d.put(`${PREFIX}/${job._id}/2026-09-18T03:00:00.000Z.json.gz`, healthyBytes(job._id));
  await d.put(`${PREFIX}/${job._id}/2026-09-19T03:00:00.000Z.json.gz`, healthyBytes(job._id));
  await d.put(`${PREFIX}/${job._id}/2026-09-20T03:00:00.000Z.json.gz`, healthyBytes(job._id));
  // Present but unusable, two different ways.
  await d.put(`${PREFIX}/${job._id}/2026-09-21T03:00:00.000Z.json.gz`, Buffer.alloc(0));
  await d.put(`${PREFIX}/${job._id}/2026-09-22T03:00:00.000Z.json.gz`, Buffer.from('this is not gzip'));
  // Belongs to a different job, at the same destination.
  await d.put(`${PREFIX}/${otherJob._id}/2026-09-20T03:00:00.000Z.json.gz`, healthyBytes(otherJob._id));
}, 180_000);

afterAll(async () => {
  await (await getBackupDestinationsCollection()).deleteMany({ userId: USER });
  await (await getBackupJobsCollection()).deleteMany({ userId: USER });
  await closeMongo();
});

it('has a destination secret to work with', () => {
  expect(S3_SECRET).not.toBe('');
});

describe('what is listed', () => {
  it('lists this job’s versions NEWEST FIRST', async () => {
    const versions = await listBackupVersions(USER, job);
    expect(versions.map((v) => v.key)).toEqual([
      `${PREFIX}/${job._id}/2026-09-22T03:00:00.000Z.json.gz`,
      `${PREFIX}/${job._id}/2026-09-21T03:00:00.000Z.json.gz`,
      `${PREFIX}/${job._id}/2026-09-20T03:00:00.000Z.json.gz`,
      `${PREFIX}/${job._id}/2026-09-19T03:00:00.000Z.json.gz`,
      `${PREFIX}/${job._id}/2026-09-18T03:00:00.000Z.json.gz`,
    ]);
  }, 120_000);

  it('does NOT list another job’s objects at the same destination', async () => {
    // Several jobs legitimately share one bucket; the jobId in the key is what separates them.
    const versions = await listBackupVersions(USER, job);
    expect(versions.every((v) => !v.key.includes(otherJob._id))).toBe(true);
  }, 120_000);

  it('returns an empty list for a job that has never run, rather than failing', async () => {
    const fresh = await makeJob();
    await expect(listBackupVersions(USER, fresh)).resolves.toEqual([]);
  }, 120_000);
});

describe('usable vs merely present', () => {
  it('marks a healthy object usable', async () => {
    const versions = await listBackupVersions(USER, job);
    const healthy = versions.find((v) => v.key.includes('2026-09-20'))!;
    expect(healthy.usable).toBe(true);
    expect(healthy.sizeBytes).toBeGreaterThan(0);
  }, 120_000);

  it('marks a ZERO-LENGTH object unusable, and still lists it', async () => {
    // Listed, because it really is there and its space really is used. Not restorable, because
    // offering it would send the user to a failure at the worst possible moment.
    const versions = await listBackupVersions(USER, job);
    const empty = versions.find((v) => v.key.includes('2026-09-21'))!;
    expect(empty).toBeDefined();
    expect(empty.usable).toBe(false);
    expect(empty.sizeBytes).toBe(0);
  }, 120_000);

  it('marks an object that is not valid gzip unusable', async () => {
    const versions = await listBackupVersions(USER, job);
    const garbage = versions.find((v) => v.key.includes('2026-09-22'))!;
    expect(garbage.usable).toBe(false);
  }, 120_000);

  it('does not mark everything unusable — the healthy ones survive the check', async () => {
    // The control. A usability check that rejected every object would satisfy both cases above.
    const versions = await listBackupVersions(USER, job);
    expect(versions.filter((v) => v.usable)).toHaveLength(3);
  }, 120_000);
});

describe('corruption that a size check alone would miss', () => {
  it('marks a gzip whose CONTENTS fail verification unusable', async () => {
    // Non-zero, valid gzip, parses as JSON — and its digest does not match. Only opening it
    // catches this, which is why usability is not decided on size alone.
    const artifact = JSON.parse(JSON.stringify(buildArtifact(job._id, [{ id: 'c1', name: 'One', movies: [] }])));
    artifact.manifest.sha256 = '0'.repeat(64);
    const d = await driver();
    const key = `${PREFIX}/${job._id}/2026-09-23T03:00:00.000Z.json.gz`;
    await d.put(key, gzipSync(Buffer.from(JSON.stringify(artifact))));

    const versions = await listBackupVersions(USER, job);
    expect(versions.find((v) => v.key === key)?.usable).toBe(false);
  }, 120_000);
});
