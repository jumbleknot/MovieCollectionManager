// scripts/ci-install-compose.sh — the pinned Docker Compose plugin, installed into a job-private
// DOCKER_CONFIG by the host-runner jobs (item #1147). It replaced four `curl …/releases/latest/… -o
// ~/.docker/cli-plugins/docker-compose` steps that wrote into the `ci` user's shared home.
//
// What this pins, offline (the release asset is served from a temp dir over file://, and the installer
// runs as a COPY with its pin lines rewritten — the real script has no environment override for the
// pin): success puts the pinned version at <dir>/cli-plugins/docker-compose; bytes that do not match
// the pin are never installed; every failure names its cause and exits non-zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = 'scripts/ci-install-compose.sh';
const PLATFORM = 'linux-x86_64';

/** A release dir laid out like GitHub's: <root>/<tag>/docker-compose-<platform>, a fake plugin. */
function release({ tag = 'v9.9.9', reports = tag, omit = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'compose-release-'));
  mkdirSync(join(root, tag));
  const body = `#!/bin/sh\necho "Docker Compose version ${reports}"\n`;
  if (!omit) writeFileSync(join(root, tag, `docker-compose-${PLATFORM}`), body, { mode: 0o755 });
  return { base: pathToFileURL(root).href, sha: createHash('sha256').update(body).digest('hex') };
}

/** The real installer with its pin lines rewritten — everything else byte-for-byte as committed. */
function pinnedCopy({ version, shaFor = version, sha }) {
  const text = readFileSync(resolve(REPO_ROOT, SCRIPT), 'utf8');
  const out = text
    .replace(/^COMPOSE_VERSION=.*$/m, `COMPOSE_VERSION=${version}`)
    .replace(/^COMPOSE_SHA256_FOR=.*$/m, `COMPOSE_SHA256_FOR=${shaFor}`)
    .replace(/^COMPOSE_SHA256_LINUX_X86_64=.*$/m, `COMPOSE_SHA256_LINUX_X86_64=${sha}`);
  assert.notEqual(out, text, 'the pin lines were not found in the installer');
  const file = join(mkdtempSync(join(tmpdir(), 'compose-script-')), 'ci-install-compose.sh');
  writeFileSync(file, out);
  return file;
}

function install(base, pin, { args, platform = PLATFORM } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'compose-cfg-')), 'docker');
  const r = spawnSync('bash', [pinnedCopy({ version: 'v9.9.9', ...pin }), ...(args ?? [dir])], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, MCM_COMPOSE_BASE_URL: base, MCM_COMPOSE_PLATFORM: platform, MCM_COMPOSE_RETRY_DELAY: '1' },
  });
  return { ...r, plugin: join(dir, 'cli-plugins', 'docker-compose'), out: `${r.stdout}${r.stderr}` };
}

test('a good release installs the pinned plugin at <dir>/cli-plugins/docker-compose', () => {
  const { base, sha } = release();
  const r = install(base, { sha });
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(r.plugin), 'no plugin at <dir>/cli-plugins/docker-compose');
  assert.match(r.stdout, /sha256 verified for docker-compose-linux-x86_64 v9\.9\.9/);
  assert.match(r.stdout, /Compose v9\.9\.9 in .*cli-plugins\/docker-compose/);
});

test('bytes that do not match the committed sha256 are refused and NOT installed', () => {
  const { base } = release();
  const r = install(base, { sha: '0'.repeat(64) });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /checksum mismatch for docker-compose-linux-x86_64 \(expected 0{64}, got [0-9a-f]{64}\)/);
  assert.ok(!existsSync(r.plugin), 'an unverified plugin was installed');
});

test('a binary that reports another version fails: "passed" means the pinned version is installed', () => {
  const { base, sha } = release({ reports: 'v1.0.0' });
  const r = install(base, { sha });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /reports 'Docker Compose version v1\.0\.0', expected v9\.9\.9/);
});

test('a version bumped without its checksums fails BEFORE any download, naming the fix', () => {
  const r = install('file:///nonexistent', { version: 'v9.9.10', shaFor: 'v9.9.9', sha: '0'.repeat(64) });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /taken for v9\.9\.9 — run: node scripts\/refresh-pinned-sha256\.mjs --write/);
});

test('a failed download names the URL; an unpinned platform and a bad invocation are refused', () => {
  const missing = release({ omit: true });
  const r = install(missing.base, { sha: missing.sha });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /download failed \(curl exit \d+, after retries\): file:.*\/v9\.9\.9\/docker-compose-linux-x86_64/);

  const plat = install('file:///nonexistent', { sha: '0'.repeat(64) }, { platform: 'darwin-arm64' });
  assert.equal(plat.status, 1, plat.out);
  assert.match(plat.stderr, /no pinned sha256 for platform 'darwin-arm64'/);

  assert.equal(install('file:///nonexistent', { sha: '0'.repeat(64) }, { args: [] }).status, 2);
});

test('the committed pin is a vX.Y.Z tag with both platform checksums taken for it', () => {
  const text = readFileSync(resolve(REPO_ROOT, SCRIPT), 'utf8');
  const v = (n) => new RegExp(`^${n}=(\\S+)$`, 'm').exec(text)?.[1];
  assert.match(String(v('COMPOSE_VERSION')), /^v\d+\.\d+\.\d+$/);
  assert.equal(v('COMPOSE_SHA256_FOR'), v('COMPOSE_VERSION'));
  for (const n of ['COMPOSE_SHA256_LINUX_X86_64', 'COMPOSE_SHA256_LINUX_AARCH64']) assert.match(String(v(n)), /^[0-9a-f]{64}$/, n);
});
