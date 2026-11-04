// scripts/ci-install-trivy.sh — the pinned Trivy install shared by app-ci, infra-image-scan and
// cd-deploy. It replaced `curl … contrib/install.sh | sh` after that script failed twice on PR #929
// with no error at all (a non-200 from get.trivy.dev is logged at DEBUG level, then `set -e` exits).
//
// What this pins: every failure NAMES its cause on stderr and exits non-zero, a bad checksum or a
// wrong version installs nothing usable, and success means the pinned version is in <bindir>.
// Runs offline: the release assets are served from a temp dir over file://.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = 'scripts/ci-install-trivy.sh';
const PLATFORM = 'Linux-64bit';

/** A release dir laid out like GitHub's: <root>/<tag>/{tarball, checksums}. */
function release({ tag = 'v9.9.9', reports = '9.9.9', corruptChecksum = false, omitTarball = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'trivy-release-'));
  const version = tag.slice(1);
  const dir = join(root, tag);
  mkdirSync(dir);
  const stage = mkdtempSync(join(tmpdir(), 'trivy-stage-'));
  writeFileSync(join(stage, 'trivy'), `#!/bin/sh\necho "Version: ${reports}"\n`, { mode: 0o755 });
  const tarball = `trivy_${version}_${PLATFORM}.tar.gz`;
  // Archive path relative to cwd: GNU tar reads a `C:` prefix in -f as a remote host on Windows.
  const r = spawnSync('tar', ['-czf', tarball, '-C', stage, 'trivy'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `fixture tar failed: ${r.stderr}`);
  const sum = corruptChecksum ? '0'.repeat(64) : createHash('sha256').update(readFileSync(join(dir, tarball))).digest('hex');
  writeFileSync(
    join(dir, `trivy_${version}_checksums.txt`),
    `${sum}  ${tarball}\n${'f'.repeat(64)}  ${tarball}.sigstore.json\n`,
  );
  if (omitTarball) rmSync(join(dir, tarball));
  return pathToFileURL(root).href;
}

function install(base, tag = 'v9.9.9') {
  const bindir = join(mkdtempSync(join(tmpdir(), 'trivy-bin-')), 'bin');
  const r = spawnSync('bash', [SCRIPT, tag, bindir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, MCM_TRIVY_BASE_URL: base, MCM_TRIVY_PLATFORM: PLATFORM, MCM_TRIVY_RETRY_DELAY: '1' },
  });
  return { ...r, bindir, out: `${r.stdout}${r.stderr}` };
}

test('a good release installs the pinned version into <bindir>', () => {
  const r = install(release());
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(join(r.bindir, 'trivy')), 'no binary in <bindir>');
  assert.match(r.stdout, /sha256 verified for trivy_9\.9\.9_Linux-64bit\.tar\.gz/);
  assert.match(r.stdout, /installed Trivy 9\.9\.9 at /);
});

test('a checksum mismatch fails loudly and installs nothing', () => {
  const r = install(release({ corruptChecksum: true }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /checksum mismatch for trivy_9\.9\.9_Linux-64bit\.tar\.gz/);
  assert.ok(!existsSync(join(r.bindir, 'trivy')), 'a binary that failed its checksum was installed');
});

test('a failed download names the URL instead of exiting silently (the PR #929 failure)', () => {
  const r = install(release({ omitTarball: true }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /download failed \(curl exit \d+, after retries\): \S+\/v9\.9\.9\/trivy_9\.9\.9_Linux-64bit\.tar\.gz/);
});

test('a binary reporting a different version fails, so a green step means the PINNED version', () => {
  const r = install(release({ reports: '0.1.0' }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /reports version '0\.1\.0', expected 9\.9\.9/);
});

test('a tag that is not vX.Y.Z is refused before anything is fetched', () => {
  for (const tag of ['latest', '0.76.1', 'v0.76']) {
    const r = install('file:///nonexistent', tag);
    assert.equal(r.status, 2, `${tag}: ${r.out}`);
    assert.match(r.stderr, /is not a vX\.Y\.Z tag/);
  }
});
