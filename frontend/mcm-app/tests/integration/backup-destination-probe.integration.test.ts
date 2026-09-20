/**
 * Destination probe route (feature 073, T022 — FR-004; US1-AC1/AC2/AC4).
 *
 * Over HTTP against the real BFF, probing REAL MinIO and WebDAV servers.
 *
 * WHAT FR-004 ACTUALLY ASKS FOR is not "does it work" but WHICH of three things is wrong, and
 * the three have three different fixes: correct the address, correct the credential, or grant
 * permission. Collapsing them sends a user to re-enter a credential that was right all along.
 *
 * NOTE ON ENDPOINTS. The probe runs INSIDE the BFF container, so every endpoint below is the
 * container's spelling of these servers (compose service names on the shared network), not the
 * loopback ports the host suites use. Sending the host spelling would report "unreachable"
 * against a server that is up, which reads as a driver bug and is not one.
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

import {
  describeBackupTargets,
  itBackupTargets,
  assertBackupTargetsPresent,
} from './helpers/backup-targets';

const bff = createBffClient();
const PROBE = '/bff-api/backups/destinations/test';

const S3_ENDPOINT = process.env.BACKUP_TEST_S3_INTERNAL_ENDPOINT || 'http://mcm-bff-backup-minio:9000';
const S3_BUCKET = process.env.BACKUP_TEST_S3_BUCKET || 'mcm-backups-test';
const S3_ACCESS_KEY = process.env.BACKUP_TEST_S3_ACCESS_KEY || 'mcmbackuptest';
const S3_SECRET = process.env.BACKUP_TEST_S3_SECRET_KEY || '';
const DAV_ENDPOINT = process.env.BACKUP_TEST_WEBDAV_INTERNAL_ENDPOINT || 'http://mcm-bff-backup-webdav:6065';
const DAV_USER = process.env.BACKUP_TEST_WEBDAV_USER || 'mcmbackuptest';
const DAV_PASSWORD = process.env.BACKUP_TEST_WEBDAV_PASSWORD || '';

let user: TestUser;
let token: string;
const auth = () => ({ headers: { Authorization: `Bearer ${token}` } });

const s3Draft = (overrides: Record<string, unknown> = {}) => ({
  type: 's3',
  label: `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  endpoint: S3_ENDPOINT,
  bucket: S3_BUCKET,
  region: 'us-east-1',
  pathStyle: true,
  accessKeyId: S3_ACCESS_KEY,
  secret: S3_SECRET,
  ...overrides,
});

beforeAll(async () => {
  await ensureRopcAudienceMapper();
  user = await createTestUser('bk-probe');
  await assignRole(user.userId, 'mc-user');
  ({ accessToken: token } = await getTestTokens(user.username, user.password));
}, 60_000);

afterAll(async () => {
  const collection = await getBackupDestinationsCollection();
  if (user) await collection.deleteMany({ userId: user.userId });
  if (user) await deleteTestUser(user.userId);
  await closeMongo();
});

itBackupTargets('has credentials to probe with — without them every case below is the same failure', () => {
  expect(S3_SECRET).not.toBe('');
  expect(DAV_PASSWORD).not.toBe('');
});

describeBackupTargets('the four outcomes are told apart (FR-004)', () => {
  it('reachable, authorised, can write → ok', async () => {
    const res = await bff.post(PROBE, s3Draft(), auth());
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
  });

  it('credentials rejected → says so, and does NOT say unreachable', async () => {
    const res = await bff.post(PROBE, s3Draft({ secret: 'wrong-secret-value' }), auth());
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(false);
    expect(res.data.reason).toMatch(/credential/i);
    expect(res.data.reason).not.toMatch(/reach/i);
  });

  it('unreachable → says so, and does NOT say credentials', async () => {
    const res = await bff.post(
      PROBE,
      s3Draft({ endpoint: 'http://mcm-bff-backup-minio:9999' }),
      auth(),
    );
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(false);
    expect(res.data.reason).toMatch(/reach/i);
    expect(res.data.reason).not.toMatch(/credential/i);
  });

  it('authorised but cannot write there → says so, distinctly from the other two', async () => {
    const res = await bff.post(PROBE, s3Draft({ bucket: 'no-such-bucket-073' }), auth());
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(false);
    expect(res.data.reason).toMatch(/bucket|permit|write/i);
  });

  it('probes WebDAV as well, through the same route', async () => {
    const res = await bff.post(
      PROBE,
      {
        type: 'webdav',
        label: `probe-dav-${Date.now()}`,
        endpoint: DAV_ENDPOINT,
        username: DAV_USER,
        secret: DAV_PASSWORD,
      },
      auth(),
    );
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
  });
});

describeBackupTargets('the probe is not a way around the save-time guard', () => {
  it('refuses a blocked address (FR-005), with no probe attempted', async () => {
    // Without this the probe would be a general-purpose "make my server fetch this URL"
    // primitive — strictly more useful to an attacker than the save path it sits beside.
    const res = await bff.post(PROBE, s3Draft({ endpoint: 'http://169.254.169.254/' }), auth());
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toMatch(/not allowed/i);
  });
});

describeBackupTargets('a draft can be probed before it is committed', () => {
  it('accepts an unsaved draft and stores nothing', async () => {
    const before = await (await getBackupDestinationsCollection()).countDocuments({ userId: user.userId });
    const res = await bff.post(PROBE, s3Draft(), auth());
    expect(res.status).toBe(200);
    const after = await (await getBackupDestinationsCollection()).countDocuments({ userId: user.userId });
    expect(after).toBe(before);
  });

  it('accepts a SAVED destination by id, using its stored secret', async () => {
    // The user does not resend the credential to re-test a saved destination — they do not have
    // it any more, because it is never returned.
    const created = await bff.post('/bff-api/backups/destinations', s3Draft(), auth());
    expect(created.status).toBe(201);
    const res = await bff.post(PROBE, { destinationId: created.data.id }, auth());
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
  });

  it('records the outcome on the saved destination', async () => {
    const created = await bff.post('/bff-api/backups/destinations', s3Draft(), auth());
    await bff.post(PROBE, { destinationId: created.data.id }, auth());
    const read = await bff.get(`/bff-api/backups/destinations/${created.data.id}`, auth());
    expect(read.data.lastTestResult).toEqual({ ok: true });
    expect(Date.parse(read.data.lastTestedAt)).not.toBeNaN();
  });

  it('answers 404 for another user’s destination id', async () => {
    const res = await bff.post(PROBE, { destinationId: '00000000-0000-4000-8000-000000000000' }, auth());
    expect(res.status).toBe(404);
  });
});

describeBackupTargets('nothing sensitive comes back', () => {
  it('never echoes the submitted secret or an upstream body', async () => {
    const res = await bff.post(PROBE, s3Draft({ secret: 'super-secret-probe-value' }), auth());
    const serialized = JSON.stringify(res.data);
    expect(serialized).not.toContain('super-secret-probe-value');
    expect(serialized).not.toMatch(/<\?xml|<Error>/);
  });
});
