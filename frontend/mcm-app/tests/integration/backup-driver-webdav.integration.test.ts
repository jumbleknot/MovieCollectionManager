/**
 * WebDAV driver integration tests (feature 073, T016 — FR-001, FR-004, FR-011).
 *
 * AGAINST A REAL WebDAV SERVER, with no mocking. The point of this tier is specifically that the
 * REAL server's dialect is what gets exercised: PROPFIND responses differ between
 * implementations in namespace prefix (`D:` vs `d:` vs none), in whether `href` is absolute or
 * path-only, and in whether a collection reports `getcontentlength` at all. A hand-written XML
 * fixture would encode MY guess at all three, and the driver would pass here and fail against
 * the user's NAS.
 *
 *   docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml \
 *     --profile backups up -d
 *
 * Run with MCM_REQUIRE_BACKUP_TARGETS=1 MCM_REQUIRE_LIVE_STACK=1 and WATCH THE SKIP COUNT.
 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import { DestinationUrlNotAllowedError } from '@/bff-server/backup-destination-url-guard';
import type { WebdavBackupDestination } from '@/types/backups';

const DAV_ENDPOINT = process.env.BACKUP_TEST_WEBDAV_ENDPOINT || 'http://localhost:9102';
const DAV_USER = process.env.BACKUP_TEST_WEBDAV_USER || 'mcmbackuptest';
const DAV_PASSWORD = process.env.BACKUP_TEST_WEBDAV_PASSWORD || '';

const PREFIX = `it-${randomUUID()}`;

function destination(overrides: Partial<WebdavBackupDestination> = {}): WebdavBackupDestination {
  return {
    _id: 'dest-dav-test',
    userId: 'user-dav-test',
    type: 'webdav',
    label: 'webdav integration target',
    endpoint: DAV_ENDPOINT,
    username: DAV_USER,
    basePath: PREFIX,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const driverFor = (d: WebdavBackupDestination, secret = DAV_PASSWORD) => createBackupDriver(d, secret);

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require('@/config/env') as { env: { backupAllowedDestinationHosts: string } };
  const hosts = new Set(env.backupAllowedDestinationHosts.split(',').map((h) => h.trim()).filter(Boolean));
  hosts.add(new URL(DAV_ENDPOINT).hostname);
  env.backupAllowedDestinationHosts = [...hosts].join(',');
});

it('has a password to test with — an empty one would make every case below meaningless', () => {
  expect(DAV_PASSWORD).not.toBe('');
});

describe('put / get', () => {
  it('round-trips binary bytes exactly', async () => {
    const driver = await driverFor(destination());
    const original = gzipSync(Buffer.from(JSON.stringify({ manifest: { formatVersion: 1 } })));
    const key = `${PREFIX}/roundtrip/${randomUUID()}.json.gz`;

    await driver.put(key, original, 'application/gzip');
    expect(Buffer.compare(await driver.get(key), original)).toBe(0);
  });

  it('creates intermediate collections rather than failing on a missing parent', async () => {
    // WebDAV PUT does NOT create parent collections — it answers 409 Conflict. An S3 key is a
    // flat string and a WebDAV path is a tree, and this is the single biggest behavioural
    // difference between the two drivers behind one interface. A driver that assumes S3
    // semantics fails on the FIRST backup to a fresh NAS and works ever after, which is the
    // worst possible distribution of that bug.
    const driver = await driverFor(destination());
    const key = `${PREFIX}/deep/nested/path/${randomUUID()}.json.gz`;
    await driver.put(key, Buffer.from('nested'));
    expect((await driver.get(key)).toString()).toBe('nested');
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
    expect(listed.every((o) => o.sizeBytes === 1)).toBe(true);
    expect(listed.every((o) => !Number.isNaN(Date.parse(o.lastModified)))).toBe(true);
  });

  it('does not list the collection itself as though it were a backup', async () => {
    // PROPFIND Depth:1 returns the collection as its OWN first entry. Included, every version
    // list would carry a phantom zero-byte "version" that is really the folder, and it would be
    // offered for restore.
    const driver = await driverFor(destination());
    const dir = `${PREFIX}/selfref`;
    await driver.put(`${dir}/only.json.gz`, Buffer.from('x'));
    const listed = await driver.list(`${dir}/`);
    expect(listed).toHaveLength(1);
    expect(listed[0].key).toBe(`${dir}/only.json.gz`);
  });

  it('returns an empty list for a prefix that does not exist', async () => {
    // A 404 from PROPFIND means "no versions", not "the destination is broken". Throwing here
    // would make a job's very first version listing an error.
    const driver = await driverFor(destination());
    expect(await driver.list(`${PREFIX}/nothing-here/`)).toEqual([]);
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
    expect(await (await driverFor(destination())).testConnection()).toEqual({ ok: true });
  });

  it('credentials rejected → credentials-rejected, not "unreachable"', async () => {
    const outcome = await (await driverFor(destination(), 'wrong-password')).testConnection();
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('credentials-rejected');
  });

  it('unreachable → unreachable, not "credentials rejected"', async () => {
    const outcome = await (
      await driverFor(destination({ endpoint: 'http://localhost:9199' }))
    ).testConnection();
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('unreachable');
  });

  it('never leaks the password or the upstream body into the reason', async () => {
    const outcome = await (await driverFor(destination(), 'super-secret-value')).testConnection();
    expect(outcome.reason ?? '').not.toContain('super-secret-value');
    expect(outcome.reason ?? '').not.toMatch(/<\?xml|<D:/);
  });
});

describe('the guard is not bypassable through the driver', () => {
  it('refuses to build a driver for an address the guard rejects', async () => {
    await expect(
      driverFor(destination({ endpoint: 'http://169.254.169.254/' })),
    ).rejects.toBeInstanceOf(DestinationUrlNotAllowedError);
  });
});
