// scripts/ci-install-rust-audit.sh — the sast job's rustup + prebuilt cargo-audit (item #1114). It
// replaced `curl https://sh.rustup.rs | sh` and a per-run `cargo install cargo-audit` compile.
//
// What this pins, offline (assets served over file://): bytes that do not match the pinned sha256 are
// NEVER executed or installed, every failure names its cause and exits non-zero, and the script
// refuses a platform it holds no (asset, sha256) pair for. The success path needs the real pinned
// artefacts, so it is proven on the CI run itself — and `renovate-workflow.guard.test.mjs` holds the
// (version, sha256) pairing that a Renovate bump would otherwise break.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = 'scripts/ci-install-rust-audit.sh';

/**
 * A rustup archive laid out like static.rust-lang.org, holding a rustup-init that is NOT the pinned
 * bytes: if it ever runs, it drops a marker file — which is exactly what must never happen.
 */
function fakeRustupArchive({ omit = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rustup-archive-'));
  const marker = join(root, 'EXECUTED');
  const dir = join(root, '1.29.3', 'x86_64-unknown-linux-gnu');
  mkdirSync(dir, { recursive: true });
  if (!omit) writeFileSync(join(dir, 'rustup-init'), `#!/bin/sh\ntouch '${marker.replace(/\\/g, '/')}'\n`, { mode: 0o755 });
  return { base: pathToFileURL(root).href, marker };
}

function install({ base, platform = 'Linux-x86_64', args = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rust-audit-home-'));
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home, CARGO_HOME: join(home, '.cargo'), RUSTUP_HOME: join(home, '.rustup'),
      MCM_RUSTUP_BASE_URL: base ?? 'file:///nonexistent',
      MCM_CARGO_AUDIT_BASE_URL: 'file:///nonexistent',
      MCM_RUST_PLATFORM: platform,
      MCM_RUST_RETRY_DELAY: '1',
    },
  });
  return { ...r, home, out: `${r.stdout}${r.stderr}` };
}

test('a rustup-init whose bytes do not match the pinned sha256 is refused and NEVER executed', () => {
  const { base, marker } = fakeRustupArchive();
  const r = install({ base });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /checksum mismatch for rustup-init \(expected b1c8cb14/);
  assert.ok(!existsSync(marker), 'the unverified rustup-init was executed');
  assert.ok(!existsSync(join(r.home, '.cargo', 'bin', 'cargo-audit')), 'cargo-audit was installed after a failed verification');
});

test('a download that fails names the URL and exits 1', () => {
  const { base } = fakeRustupArchive({ omit: true });
  const r = install({ base });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /download failed \(curl exit \d+, after retries\): file:.*\/1\.29\.3\/x86_64-unknown-linux-gnu\/rustup-init/);
});

test('a platform with no pinned (asset, sha256) pair is refused before anything is fetched', () => {
  const r = install({ platform: 'Linux-aarch64' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /pinned for Linux-x86_64 only, not Linux-aarch64/);
  assert.doesNotMatch(r.out, /downloaded/);
});

test('arguments are a usage error (2): the pins live in the script, not on a command line', () => {
  const r = install({ args: ['0.23.0'] });
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /usage:/);
});
