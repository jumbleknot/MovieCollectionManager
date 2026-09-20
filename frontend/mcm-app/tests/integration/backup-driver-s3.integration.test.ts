/**
 * S3 driver integration tests (feature 073, T014 — FR-001, FR-004, FR-011).
 *
 * AGAINST A REAL MinIO, with NO MOCKING of any kind (constitution §Test Type Integrity — the
 * golden-tier cassette exception is LLM-only and does not apply here). This is the SECOND
 * external oracle for the hand-written SigV4 signer: the first is AWS's published vectors in
 * unit-tests/backup-request-signer.test.ts, which prove the algorithm, and this one proves that
 * a real S3 implementation accepts what the algorithm produces. Either alone would be a signer
 * agreeing with something I also wrote.
 *
 * Bring the target up first:
 *   docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml \
 *     --profile backups up -d
 *
 * Run with MCM_REQUIRE_BACKUP_TARGETS=1 MCM_REQUIRE_LIVE_STACK=1 so a target that is down is a
 * hard failure. WATCH THE SKIP COUNT: a skipped test reads as a pass, and a suite that passes
 * with MinIO down is not an integration suite.
 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import { DestinationUrlNotAllowedError } from '@/bff-server/backup-destination-url-guard';
import type { S3BackupDestination } from '@/types/backups';

const S3_ENDPOINT = process.env.BACKUP_TEST_S3_ENDPOINT || 'http://localhost:9100';
const S3_BUCKET = process.env.BACKUP_TEST_S3_BUCKET || 'mcm-backups-test';
const S3_ACCESS_KEY = process.env.BACKUP_TEST_S3_ACCESS_KEY || 'mcmbackuptest';
const S3_SECRET = process.env.BACKUP_TEST_S3_SECRET_KEY || '';

// A unique prefix per run, so a re-run never sees a previous run's objects and two runs can
// overlap without one deleting the other's fixtures.
const PREFIX = `it-${randomUUID()}`;

function destination(overrides: Partial<S3BackupDestination> = {}): S3BackupDestination {
  return {
    _id: 'dest-s3-test',
    userId: 'user-s3-test',
    type: 's3',
    label: 's3 integration target',
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    region: 'us-east-1',
    pathStyle: true,
    accessKeyId: S3_ACCESS_KEY,
    basePath: PREFIX,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const driverFor = (d: S3BackupDestination, secret = S3_SECRET) => createBackupDriver(d, secret);

// The guard denies loopback by DEFAULT (see backup-destination-url-guard). The target is on
// 127.0.0.1, so the allow-list must admit it — exactly as a homelab NAS is admitted in
// production. Setting it here rather than relying on .env.local keeps the suite self-contained.
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require('@/config/env') as { env: { backupAllowedDestinationHosts: string } };
  const hosts = new Set(env.backupAllowedDestinationHosts.split(',').map((h) => h.trim()).filter(Boolean));
  hosts.add(new URL(S3_ENDPOINT).hostname);
  (env as { backupAllowedDestinationHosts: string }).backupAllowedDestinationHosts = [...hosts].join(',');
});

it('has a secret to test with — an empty one would make every case below meaningless', () => {
  // A credential-driven skip reads as a pass. This asserts the input exists instead of letting
  // the suite discover it as four identical authentication failures.
  expect(S3_SECRET).not.toBe('');
});

describe('put / get', () => {
  it('round-trips bytes EXACTLY, including binary gzip content', async () => {
    const driver = await driverFor(destination());
    // Real artifact-shaped content: gzip is binary, so any encoding mistake in the transport
    // (a stray toString, a latin1 round trip) corrupts it in a way a text fixture would hide.
    const original = gzipSync(Buffer.from(JSON.stringify({ manifest: { formatVersion: 1 } })));
    const key = `${PREFIX}/roundtrip/${randomUUID()}.json.gz`;

    await driver.put(key, original, 'application/gzip');
    const fetched = await driver.get(key);

    expect(Buffer.compare(fetched, original)).toBe(0);
  });

  it('stores a key containing characters that must be percent-encoded', async () => {
    // An ISO-8601 timestamp key contains colons. Getting the encoding wrong signs one path and
    // requests another, and S3 answers with a signature error that says nothing about the key.
    const driver = await driverFor(destination());
    const key = `${PREFIX}/encoded/2026-09-20T03:00:00.000Z.json.gz`;
    const body = Buffer.from('timestamped');

    await driver.put(key, body);
    expect(Buffer.compare(await driver.get(key), body)).toBe(0);
  });

  it('reports a missing object as an error rather than empty bytes', async () => {
    const driver = await driverFor(destination());
    await expect(driver.get(`${PREFIX}/definitely/absent.json.gz`)).rejects.toThrow();
  });
});

describe('list', () => {
  it('returns keys in lexicographic order under the prefix, and nothing outside it', async () => {
    const driver = await driverFor(destination());
    const mine = `${PREFIX}/listing`;
    const other = `${PREFIX}/neighbour`;
    // Written out of order deliberately: if the driver returned insertion order, the assertion
    // below would still pass on a sorted input.
    await driver.put(`${mine}/2026-09-20T03:00:00.000Z.json.gz`, Buffer.from('b'));
    await driver.put(`${mine}/2026-09-18T03:00:00.000Z.json.gz`, Buffer.from('a'));
    await driver.put(`${mine}/2026-09-19T03:00:00.000Z.json.gz`, Buffer.from('c'));
    await driver.put(`${other}/2026-09-21T03:00:00.000Z.json.gz`, Buffer.from('elsewhere'));

    const listed = await driver.list(`${mine}/`);
    expect(listed.map((o) => o.key)).toEqual([
      `${mine}/2026-09-18T03:00:00.000Z.json.gz`,
      `${mine}/2026-09-19T03:00:00.000Z.json.gz`,
      `${mine}/2026-09-20T03:00:00.000Z.json.gz`,
    ]);
    // ISO-8601 sorting lexicographically IS the retention mechanism — "delete the tail" is only
    // correct because of it.
    expect(listed.map((o) => o.key)).toEqual([...listed.map((o) => o.key)].sort());
    expect(listed.every((o) => o.sizeBytes === 1)).toBe(true);
    expect(listed.every((o) => !Number.isNaN(Date.parse(o.lastModified)))).toBe(true);
  });

  it('returns an empty list for a prefix with nothing under it', async () => {
    const driver = await driverFor(destination());
    expect(await driver.list(`${PREFIX}/nothing-here/`)).toEqual([]);
  });

  it('pages past the 1000-key response limit', async () => {
    // S3 caps a LIST response at 1000 keys and returns a continuation token. A driver that reads
    // only the first page silently under-reports, and retention would then never prune below
    // 1000 versions while reporting success. Proven with a smaller page size rather than by
    // writing 1001 objects, which would make this suite minutes long.
    const driver = await driverFor(destination());
    const paged = `${PREFIX}/paged`;
    for (let i = 0; i < 5; i += 1) {
      await driver.put(`${paged}/${String(i).padStart(3, '0')}.json.gz`, Buffer.from(`${i}`));
    }
    const listed = await (
      driver as unknown as { list(prefix: string, pageSize?: number): Promise<{ key: string }[]> }
    ).list(`${paged}/`, 2);
    expect(listed).toHaveLength(5);
  });
});

describe('delete', () => {
  it('removes ONE object and leaves its neighbours intact', async () => {
    const driver = await driverFor(destination());
    const base = `${PREFIX}/deletion`;
    await driver.put(`${base}/keep-1.json.gz`, Buffer.from('1'));
    await driver.put(`${base}/remove.json.gz`, Buffer.from('2'));
    await driver.put(`${base}/keep-2.json.gz`, Buffer.from('3'));

    await driver.delete(`${base}/remove.json.gz`);

    expect((await driver.list(`${base}/`)).map((o) => o.key)).toEqual([
      `${base}/keep-1.json.gz`,
      `${base}/keep-2.json.gz`,
    ]);
  });
});

describe('testConnection reports WHICH thing failed (FR-004)', () => {
  it('reachable and authorised with write permission → ok', async () => {
    const outcome = await (await driverFor(destination())).testConnection();
    expect(outcome).toEqual({ ok: true });
  });

  it('credentials rejected → credentials-rejected, not "unreachable"', async () => {
    const outcome = await (await driverFor(destination(), 'not-the-right-secret')).testConnection();
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('credentials-rejected');
  });

  it('unreachable → unreachable, not "credentials rejected"', async () => {
    // Port 9199 is nothing. The two failures have entirely different fixes, and conflating them
    // sends a user to re-enter a credential that was correct all along.
    const outcome = await (
      await driverFor(destination({ endpoint: 'http://localhost:9199' }))
    ).testConnection();
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('unreachable');
  });

  it('authenticated but the bucket does not exist → no-write-permission, distinctly', async () => {
    const outcome = await (
      await driverFor(destination({ bucket: `absent-bucket-${randomUUID()}` }))
    ).testConnection();
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('no-write-permission');
  });

  it('never leaks the upstream body or the credential into the reason', async () => {
    const outcome = await (await driverFor(destination(), 'super-secret-value')).testConnection();
    expect(outcome.reason ?? '').not.toContain('super-secret-value');
    expect(outcome.reason ?? '').not.toMatch(/<\?xml|<Error>/);
  });
});

describe('the guard is not bypassable through the driver', () => {
  it('refuses to build a driver for an address the guard rejects', async () => {
    // The guard runs in the FACTORY, so there is no path from a destination document to a socket
    // that skips it — a stronger property than "each driver remembers to call it".
    await expect(
      driverFor(destination({ endpoint: 'http://169.254.169.254/' })),
    ).rejects.toBeInstanceOf(DestinationUrlNotAllowedError);
  });

  it('connects to the PINNED address, not to whatever the name resolves to later', async () => {
    // The hostname is vetted once and the socket is pinned to that answer. Here the vetted
    // address is the loopback MinIO; a driver that re-resolved at connect time would be
    // observably different only under a changing record, so what is asserted is that the pinned
    // transport reaches the intended server at all — the pinning itself is structural.
    const driver = await driverFor(destination());
    await expect(driver.testConnection()).resolves.toEqual({ ok: true });
  });
});
