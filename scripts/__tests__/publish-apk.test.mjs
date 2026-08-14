// Item #161 — scripts/cd/publish-apk.mjs, the prod APK's route into the generic package registry.
//
// What is worth pinning here is NOT "it PUTs a file" — it is the three places where a wrong answer
// would be QUIET:
//
//   1. Retention deleting the WRONG versions. The forge orders packages by NAME, not age, and
//      `1.10.0` sorts before `1.9.0` as a string — so a name-ordered prune deletes the NEWEST build
//      and leaves the oldest. Nothing about that is visible until someone needs the current APK.
//   2. A pin that does not pin, or that consumes a retention slot and evicts a fresh build.
//   3. A failure that fails the job. `prod-apk` is non-blocking by design (nothing `needs:` it); if
//      this step can turn it red, a registry hiccup starts costing deploy attention (AC4).
//
// Deterministic, offline, token-free, node: built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APK_PACKAGE,
  PIN_SUFFIX,
  RETAIN_VERSIONS,
  apkVersion,
  findApk,
  forgeEndpoint,
  packagesApi,
  pruneOldVersions,
  publish,
  selectPrunableVersions,
  sha256Sidecar,
} from '../cd/publish-apk.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts/cd/publish-apk.mjs');

const at = (iso) => ({ created_at: iso });
const v = (version, iso) => ({ name: APK_PACKAGE, version, ...at(iso) });

// --- Version identity ---------------------------------------------------------------------------

test('apkVersion is app.json version + the short sha, unique per commit', () => {
  assert.equal(apkVersion('1.2.0', 'a1b2c3d4e5f6'), '1.2.0-a1b2c3d');
  assert.equal(apkVersion(' 1.2.0 ', 'a1b2c3d4e5f6'), '1.2.0-a1b2c3d');
});

test('apkVersion falls back to `local` off-CI rather than emitting a bare version', () => {
  // A bare `1.2.0` would collide with the NEXT local build and 409 forever.
  assert.equal(apkVersion('1.2.0', undefined), '1.2.0-local');
  assert.equal(apkVersion('1.2.0', ''), '1.2.0-local');
});

test('apkVersion refuses an absent expo.version instead of publishing `-a1b2c3d`', () => {
  assert.throws(() => apkVersion(undefined, 'a1b2c3d'), /expo\.version/);
  assert.throws(() => apkVersion('   ', 'a1b2c3d'), /expo\.version/);
});

// --- Retention ----------------------------------------------------------------------------------

test('prune keeps the newest N by created_at — NOT by version name', () => {
  // The trap: as strings, `1.10.0-…` < `1.9.0-…`, so a name-ordered prune would delete the NEWEST.
  const versions = [
    v('1.9.0-aaaaaaa', '2026-01-01T00:00:00Z'),
    v('1.10.0-bbbbbbb', '2026-06-01T00:00:00Z'),
    v('1.8.0-ccccccc', '2025-12-01T00:00:00Z'),
  ];
  const doomed = selectPrunableVersions(versions, { retain: 2 });
  assert.deepEqual(
    doomed.map((x) => x.version),
    ['1.8.0-ccccccc'],
  );
});

test('prune is a no-op below the retention ceiling', () => {
  const versions = Array.from({ length: RETAIN_VERSIONS }, (_, i) =>
    v(`1.0.0-${String(i).padStart(7, '0')}`, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
  );
  assert.deepEqual(selectPrunableVersions(versions), []);
});

test(`a \`${PIN_SUFFIX}\` version is never pruned and never consumes a retention slot`, () => {
  const versions = [
    v('1.0.0-pinned' + PIN_SUFFIX, '2020-01-01T00:00:00Z'), // ancient AND pinned
    v('1.0.0-newest', '2026-06-03T00:00:00Z'),
    v('1.0.0-middle', '2026-06-02T00:00:00Z'),
    v('1.0.0-oldest', '2026-06-01T00:00:00Z'),
  ];
  const doomed = selectPrunableVersions(versions, { retain: 2 });
  // The pin survives despite being the oldest, AND both live builds inside the window survive: had
  // the pin consumed a slot, `1.0.0-middle` would have been evicted by a version nobody deployed.
  assert.deepEqual(
    doomed.map((x) => x.version),
    ['1.0.0-oldest'],
  );
});

test('an unparseable created_at is KEPT — deleting on a parse failure is the destructive direction', () => {
  const versions = [
    v('1.0.0-newest', '2026-06-03T00:00:00Z'),
    { name: APK_PACKAGE, version: '1.0.0-mystery', created_at: 'not-a-date' },
    v('1.0.0-oldest', '2026-06-01T00:00:00Z'),
  ];
  const doomed = selectPrunableVersions(versions, { retain: 1 });
  assert.deepEqual(
    doomed.map((x) => x.version),
    ['1.0.0-oldest'],
  );
});

test('prune ignores rows for other packages and unnamed versions', () => {
  const versions = [
    v('1.0.0-keepme', '2026-06-03T00:00:00Z'),
    { name: APK_PACKAGE, version: '', created_at: '2026-06-02T00:00:00Z' },
    v('1.0.0-doomed', '2026-06-01T00:00:00Z'),
  ];
  assert.deepEqual(
    selectPrunableVersions(versions, { retain: 1 }).map((x) => x.version),
    ['1.0.0-doomed'],
  );
});

// --- APK discovery ------------------------------------------------------------------------------

test('findApk picks build-apk.mjs’s descriptive copy, never Gradle’s app-release.apk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apk-'));
  writeFileSync(join(dir, 'app-release.apk'), 'gradle');
  writeFileSync(join(dir, 'MovieCollectionManager-1.2.0-release-a1b2c3d.apk'), 'friendly');
  assert.equal(findApk(dir).name, 'MovieCollectionManager-1.2.0-release-a1b2c3d.apk');
});

test('findApk takes the NEWEST when a stale build left more than one behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apk-'));
  const stale = join(dir, 'MovieCollectionManager-1.1.0-release-old0000.apk');
  const fresh = join(dir, 'MovieCollectionManager-1.2.0-release-new0000.apk');
  writeFileSync(stale, 'stale');
  writeFileSync(fresh, 'fresh');
  utimesSync(stale, new Date('2020-01-01'), new Date('2020-01-01'));
  assert.equal(findApk(dir).name, 'MovieCollectionManager-1.2.0-release-new0000.apk');
});

test('findApk returns null for a missing or empty dir rather than throwing', () => {
  assert.equal(findApk(join(tmpdir(), 'definitely-not-here-161')), null);
  assert.equal(findApk(mkdtempSync(join(tmpdir(), 'apk-'))), null);
});

// --- Sidecar ------------------------------------------------------------------------------------

test('the sidecar is in `sha256sum -c` format so the stock tool verifies the download', () => {
  const line = sha256Sidecar('abc123', 'MovieCollectionManager-1.2.0-release-a1b2c3d.apk');
  assert.equal(line, 'abc123  MovieCollectionManager-1.2.0-release-a1b2c3d.apk\n');
  assert.match(line, /^[0-9a-f]+ {2}\S+\n$/); // two spaces — one is `sha256sum -c: no properly formatted lines`
});

// --- Endpoint -----------------------------------------------------------------------------------

test('forgeEndpoint takes the owner from GITHUB_REPOSITORY, not the repo name', () => {
  const { base, owner } = forgeEndpoint({ GITHUB_SERVER_URL: 'http://forge.example:3000', GITHUB_REPOSITORY: 'jumbleknot/mcm' });
  assert.equal(base, 'http://forge.example:3000/api/v1');
  assert.equal(owner, 'jumbleknot'); // packages hang off the OWNER, not owner/repo
});

test('the generic registry path lives outside /api/v1 while the list/delete paths stay inside it', () => {
  const seen = [];
  const api = packagesApi({
    base: 'http://forge.example:3000/api/v1',
    owner: 'jumbleknot',
    token: 't',
    fetchImpl: async (url, opts) => {
      seen.push(`${opts.method} ${url}`);
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  return (async () => {
    await api.upload('1.2.0-a1b2c3d', 'x.apk', Buffer.from('x'), 'application/vnd.android.package-archive');
    await api.listVersions();
    await api.deleteVersion('1.2.0-a1b2c3d');
    assert.deepEqual(seen, [
      `PUT http://forge.example:3000/api/packages/jumbleknot/generic/${APK_PACKAGE}/1.2.0-a1b2c3d/x.apk`,
      `GET http://forge.example:3000/api/v1/packages/jumbleknot?type=generic&q=${APK_PACKAGE}&page=1&limit=50`,
      `DELETE http://forge.example:3000/api/v1/packages/jumbleknot/generic/${APK_PACKAGE}/1.2.0-a1b2c3d`,
    ]);
  })();
});

test('listVersions PAGINATES — a single page would silently stop pruning past 50 versions', async () => {
  const pages = {
    1: Array.from({ length: 50 }, (_, i) => v(`1.0.0-p1-${i}`, '2026-01-01T00:00:00Z')),
    2: [v('1.0.0-p2-0', '2026-01-02T00:00:00Z')],
  };
  const api = packagesApi({
    base: 'http://forge.example:3000/api/v1',
    owner: 'jumbleknot',
    token: 't',
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return { ok: true, status: 200, json: async () => pages[page] ?? [] };
    },
  });
  assert.equal((await api.listVersions()).length, 51);
});

// --- Publish + prune behaviour ------------------------------------------------------------------

function fakeApi({ uploadStatus = 201, versions = [], onDelete = () => 204 } = {}) {
  const calls = { uploads: [], deletes: [] };
  return {
    calls,
    upload: async (version, filename, body) => {
      calls.uploads.push({ version, filename, bytes: body.length });
      const status = typeof uploadStatus === 'function' ? uploadStatus(filename) : uploadStatus;
      return { ok: status >= 200 && status < 300, status };
    },
    listVersions: async () => versions,
    deleteVersion: async (version) => {
      calls.deletes.push(version);
      const status = onDelete(version);
      return { ok: status >= 200 && status < 300, status };
    },
  };
}

test('publish uploads the APK and its sha256 sidecar into the same version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apk-'));
  const name = 'MovieCollectionManager-1.2.0-release-a1b2c3d.apk';
  writeFileSync(join(dir, name), 'apk-bytes');
  const api = fakeApi();
  const out = await publish({ api, apk: findApk(dir), version: '1.2.0-a1b2c3d' });

  assert.deepEqual(
    api.calls.uploads.map((u) => u.filename),
    [name, `${name}.sha256`],
  );
  assert.equal(out.sha256, execFileSync('sha256sum', [join(dir, name)], { encoding: 'utf8' }).split(' ')[0]);
});

test('a 409 on re-publishing the same commit is "already published", not a failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apk-'));
  writeFileSync(join(dir, 'MovieCollectionManager-1.2.0-release-a1b2c3d.apk'), 'apk-bytes');
  const api = fakeApi({ uploadStatus: 409 });
  // Overwriting instead would destroy an APK someone may have pinned or installed from.
  await publish({ api, apk: findApk(dir), version: '1.2.0-a1b2c3d' });
});

test('a 403 upload names the missing scope rather than just the status code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apk-'));
  writeFileSync(join(dir, 'MovieCollectionManager-1.2.0-release-a1b2c3d.apk'), 'apk-bytes');
  const api = fakeApi({ uploadStatus: 403 });
  await assert.rejects(() => publish({ api, apk: findApk(dir), version: '1.2.0-a1b2c3d' }), /write:package/);
});

test('one undeletable version does not abort the rest of the prune', async () => {
  const versions = [
    v('1.0.0-newest', '2026-06-04T00:00:00Z'),
    v('1.0.0-stuck', '2026-06-03T00:00:00Z'),
    v('1.0.0-old-a', '2026-06-02T00:00:00Z'),
    v('1.0.0-old-b', '2026-06-01T00:00:00Z'),
  ];
  const api = fakeApi({ versions, onDelete: (name) => (name === '1.0.0-stuck' ? 500 : 204) });
  const out = await pruneOldVersions(api, { retain: 1 });
  assert.deepEqual(api.calls.deletes, ['1.0.0-stuck', '1.0.0-old-a', '1.0.0-old-b']);
  assert.equal(out.pruned, 2);
});

test('a 404 on delete counts as pruned — the version is already gone', async () => {
  const versions = [v('1.0.0-newest', '2026-06-02T00:00:00Z'), v('1.0.0-gone', '2026-06-01T00:00:00Z')];
  const api = fakeApi({ versions, onDelete: () => 404 });
  assert.equal((await pruneOldVersions(api, { retain: 1 })).pruned, 1);
});

// --- AC4: the step can never fail the job -------------------------------------------------------
//
// Run the REAL CLI, not a stub of it — the whole point is the process exit code prod-apk observes.

const runCli = (env) => {
  const r = execFileSync('node', [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    // execFileSync throws on a non-zero exit, which IS the assertion — catch it below.
  });
  return r;
};

test('AC4: a missing REGISTRY_TOKEN exits 0 and says so loudly', () => {
  const out = runCli({ REGISTRY_TOKEN: '' });
  assert.match(out, /::error::.*REGISTRY_TOKEN is empty/);
});

test('AC4: no APK on disk exits 0 and says so loudly', () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'apk-'));
  const out = runCli({ REGISTRY_TOKEN: 'x', APK_OUTPUT_DIR: emptyDir });
  assert.match(out, /::error::.*no MovieCollectionManager-\*\.apk found/);
});

test('AC4: an unreachable registry exits 0 and says so loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apk-'));
  writeFileSync(join(dir, 'MovieCollectionManager-1.2.0-release-a1b2c3d.apk'), 'apk-bytes');
  const appDir = mkdtempSync(join(tmpdir(), 'app-'));
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'app.json'), JSON.stringify({ expo: { version: '1.2.0' } }));
  const out = runCli({
    REGISTRY_TOKEN: 'x',
    APK_OUTPUT_DIR: dir,
    APP_JSON_PATH: join(appDir, 'app.json'),
    GITHUB_SHA: 'a1b2c3d4e5',
    // 127.0.0.1:1 refuses instantly — no network, no timeout wait.
    GITHUB_SERVER_URL: 'http://127.0.0.1:1',
    GITHUB_REPOSITORY: 'jumbleknot/mcm',
  });
  assert.match(out, /::error::.*publish suppressed/);
});
