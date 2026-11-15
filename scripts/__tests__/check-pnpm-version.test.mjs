// check-pnpm-version.mjs: the pnpm on PATH must be the root `packageManager` version (item #1025).
//
// Each case runs the real script as a subprocess, with a fake `pnpm` first on PATH that prints a
// chosen version and records the directory it was run from. The last case uses the real pnpm on the
// real tree, so the check is shown to pass on the setup it is meant to guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-pnpm-version.mjs');

/** A temp dir holding a manifest pinning `pin`, and (unless `fakeVersion` is null) a fake pnpm. */
function fixture(t, { pin = 'pnpm@12.18.0', fakeVersion = '12.18.0' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-pnpm-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = join(dir, 'package.json');
  writeFileSync(manifest, JSON.stringify({ name: 'fixture', packageManager: pin }));
  const bin = join(dir, 'bin');
  const cwdLog = join(dir, 'pnpm-cwd.txt');
  spawnSync('mkdir', [bin]);
  if (fakeVersion !== null) {
    const pnpm = join(bin, 'pnpm');
    writeFileSync(pnpm, `#!/bin/sh\npwd > '${cwdLog}'\necho '${fakeVersion}'\n`);
    chmodSync(pnpm, 0o755);
  }
  return { manifest, bin, cwdLog };
}

function run(args, { path } = {}) {
  const env = { ...process.env };
  // Node is spawned by absolute path, so PATH needs only the fake and /bin (for the fake's `sh`).
  // Not node's own directory: npm's global prefix puts the real pnpm right beside node, and it would
  // answer for a fake that is deliberately absent.
  if (path !== undefined) env.PATH = [path, '/bin'].join(delimiter);
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
}

test('RED: a pnpm on PATH that differs from the pin fails, naming both versions', (t) => {
  const f = fixture(t, { pin: 'pnpm@12.18.0', fakeVersion: '12.17.0' });
  const r = run([f.manifest], { path: f.bin });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /::error::.*12\.17\.0.*12\.18\.0/);
});

test('a pnpm on PATH equal to the pin passes', (t) => {
  const f = fixture(t, { pin: 'pnpm@12.18.0', fakeVersion: '12.18.0' });
  const r = run([f.manifest], { path: f.bin });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /12\.18\.0/);
});

test('pnpm is asked from outside any workspace, where it cannot self-switch to the pin', (t) => {
  const f = fixture(t);
  const r = run([f.manifest], { path: f.bin });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const cwd = readFileSync(f.cwdLog, 'utf8').trim();
  assert.ok(relative(REPO_ROOT, cwd).startsWith('..'), `pnpm ran inside the repo: ${cwd}`);
  assert.notEqual(cwd, dirname(f.manifest), 'pnpm ran beside the manifest');
});

test('no pnpm on PATH fails rather than passing', (t) => {
  const f = fixture(t, { fakeVersion: null });
  const r = run([f.manifest], { path: f.bin });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /::error::/);
});

test('a packageManager that is not pnpm@<version> is a usage error', (t) => {
  const f = fixture(t, { pin: 'npm@10.0.0' });
  const r = run([f.manifest], { path: f.bin });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

test('an unrecognised argument is refused, not ignored', () => {
  const r = run(['--dry-run']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /unrecognised/);
});

test('--help prints usage and checks nothing', () => {
  const r = run(['--help'], { path: '/nonexistent' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /packageManager/);
});

test('GREEN on the real tree: the installed pnpm is the root pin', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// install-pnpm.sh verifies what it installed (criterion 2). The Dockerfile copies only that script
// and package.json into the image, so its check is inline shell, not a call to this .mjs. Same rule:
// pnpm is asked from an empty temp dir. A fake `npm` makes the install a no-op.
function installRun(t, fakeVersion) {
  const f = fixture(t, { pin: 'pnpm@12.18.0', fakeVersion });
  const npm = join(f.bin, 'npm');
  writeFileSync(npm, '#!/bin/sh\nexit 0\n');
  chmodSync(npm, 0o755);
  const env = { ...process.env, PATH: [f.bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) };
  // node's dir is needed (the script reads packageManager with node), so hide a real pnpm there by
  // putting the fake first — it is, since f.bin leads PATH.
  return spawnSync('sh', [join(REPO_ROOT, 'scripts', 'install-pnpm.sh'), f.manifest], { encoding: 'utf8', env });
}

test('RED: install-pnpm.sh fails when the pnpm it leaves on PATH is not the pin', (t) => {
  const r = installRun(t, '12.17.0');
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /::error::.*12\.17\.0.*12\.18\.0/);
});

test('install-pnpm.sh passes when the pnpm on PATH is the pin', (t) => {
  const r = installRun(t, '12.18.0');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
