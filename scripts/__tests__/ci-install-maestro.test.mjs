// scripts/ci-install-maestro.sh — the pinned Maestro CLI, installed into a job-private dir by app-e2e
// (item #1147). It replaced `curl https://get.maestro.mobile.dev | bash`, which installed into the
// shared ~/.maestro and appended a PATH line to ~/.bashrc and ~/.zshrc on every run.
//
// Offline: the release is a zip built here (stored, no compression) and served over file://; the
// installer runs as a COPY with its pin lines rewritten. What this pins: success lays out
// <dir>/bin/maestro and <dir>/lib, and writes NOTHING under $HOME; unverified bytes are never unpacked;
// an archive that is not the pinned release is refused; every failure names its cause.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = 'scripts/ci-install-maestro.sh';
const hasUnzip = spawnSync('bash', ['-c', 'command -v unzip'], { encoding: 'utf8' }).status === 0;

/** A minimal STORED zip: [name, content, unixMode] entries. Enough for `unzip`, no dependency. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, mode = 0o644] of entries) {
    const n = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += local.length + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function release({ version = '9.9.9', jar = version, omit = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'maestro-release-'));
  mkdirSync(join(root, `cli-${version}`));
  const bytes = zip([
    ['maestro/bin/maestro', '#!/bin/sh\necho maestro\n', 0o755],
    [`maestro/lib/maestro-cli-${jar}.jar`, 'jar'],
  ]);
  if (!omit) writeFileSync(join(root, `cli-${version}`, 'maestro.zip'), bytes);
  return { base: pathToFileURL(root).href, sha: createHash('sha256').update(bytes).digest('hex') };
}

function pinnedCopy({ version, shaFor = version, sha }) {
  const text = readFileSync(resolve(REPO_ROOT, SCRIPT), 'utf8');
  const out = text
    .replace(/^MAESTRO_VERSION=.*$/m, `MAESTRO_VERSION=${version}`)
    .replace(/^MAESTRO_SHA256_FOR=.*$/m, `MAESTRO_SHA256_FOR=${shaFor}`)
    .replace(/^MAESTRO_SHA256=.*$/m, `MAESTRO_SHA256=${sha}`);
  assert.notEqual(out, text, 'the pin lines were not found in the installer');
  const file = join(mkdtempSync(join(tmpdir(), 'maestro-script-')), 'ci-install-maestro.sh');
  writeFileSync(file, out);
  return file;
}

function install(base, pin, { args } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'maestro-home-'));
  const dir = join(mkdtempSync(join(tmpdir(), 'maestro-dir-')), 'mcm-maestro');
  const r = spawnSync('bash', [pinnedCopy({ version: '9.9.9', ...pin }), ...(args ?? [dir])], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, MCM_MAESTRO_BASE_URL: base, MCM_MAESTRO_RETRY_DELAY: '1' },
  });
  return { ...r, dir, home, out: `${r.stdout}${r.stderr}` };
}

test('a good release lays out <dir>/bin and <dir>/lib, and writes nothing under $HOME', { skip: !hasUnzip && 'no unzip on this host' }, () => {
  const { base, sha } = release();
  const r = install(base, { sha });
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(join(r.dir, 'bin', 'maestro')), 'no <dir>/bin/maestro');
  assert.ok(existsSync(join(r.dir, 'lib', 'maestro-cli-9.9.9.jar')), 'no <dir>/lib');
  assert.deepEqual(readdirSync(r.home), [], 'the installer wrote into $HOME (the vendor installer appended to ~/.bashrc)');
  assert.match(r.stdout, /Maestro 9\.9\.9 in /);
});

test('bytes that do not match the committed sha256 are refused and never unpacked', () => {
  const { base } = release();
  const r = install(base, { sha: '0'.repeat(64) });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /checksum mismatch for maestro\.zip \(expected 0{64}, got [0-9a-f]{64}\)/);
  assert.ok(!existsSync(join(r.dir, 'bin')), 'an unverified archive was unpacked');
});

test('an archive that is not the pinned release is refused', { skip: !hasUnzip && 'no unzip on this host' }, () => {
  const { base, sha } = release({ jar: '1.0.0' });
  const r = install(base, { sha });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /does not carry maestro-cli-9\.9\.9\.jar/);
});

test('a version bumped without its checksum fails before any download; a failed download names the URL', () => {
  const stale = install('file:///nonexistent', { version: '9.9.10', shaFor: '9.9.9', sha: '0'.repeat(64) });
  assert.equal(stale.status, 1, stale.out);
  assert.match(stale.stderr, /taken for 9\.9\.9 — run: node scripts\/refresh-pinned-sha256\.mjs --write/);

  if (hasUnzip) {
    const missing = release({ omit: true });
    const r = install(missing.base, { sha: missing.sha });
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /download failed \(curl exit \d+, after retries\): file:.*\/cli-9\.9\.9\/maestro\.zip/);
  }
  assert.equal(install('file:///nonexistent', { sha: '0'.repeat(64) }, { args: [] }).status, 2);
});

test('the committed pin is an X.Y.Z version with a sha256 taken for it', () => {
  const text = readFileSync(resolve(REPO_ROOT, SCRIPT), 'utf8');
  const v = (n) => new RegExp(`^${n}=(\\S+)$`, 'm').exec(text)?.[1];
  assert.match(String(v('MAESTRO_VERSION')), /^\d+\.\d+\.\d+$/);
  assert.equal(v('MAESTRO_SHA256_FOR'), v('MAESTRO_VERSION'));
  assert.match(String(v('MAESTRO_SHA256')), /^[0-9a-f]{64}$/);
});
