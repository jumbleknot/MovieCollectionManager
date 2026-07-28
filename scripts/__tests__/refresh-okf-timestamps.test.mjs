// Tests for scripts/refresh-okf-timestamps.mjs — feature 043, FR-028 option 1.
//
// The script clears V12 drift on concepts a regeneration run left unchanged (i.e. verified as still
// accurate) by bumping their `timestamp`. Without it, drift NEVER clears for accurate concepts: the
// generator only rewrites files it changes, so a verified-accurate page keeps reporting stale forever
// and the FR-028 trigger fires on every feature — defeating the point of making it conditional.
//
// Deterministic, offline, node: built-ins only — CI-enforced by the guardrails glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'refresh-okf-timestamps.mjs');

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function makeBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'okf-ts-'));
  writeFileSync(join(dir, 'index.md'), '---\ntype: Reference\n---\n# I\n- [a](a.md)\n- [b](b.md)\n');
  // `a` cites a real repo file with an OLD timestamp -> drifting.
  writeFileSync(join(dir, 'a.md'), '---\ntype: R\nresource: README.md\ntimestamp: 2001-01-01T00:00:00Z\n---\nbody\n');
  // `b` has no timestamp -> can never drift, must be left alone.
  writeFileSync(join(dir, 'b.md'), '---\ntype: R\nresource: README.md\n---\nbody\n');
  return dir;
}

test('dry run by default — reports drifting concepts and writes nothing', () => {
  const dir = makeBundle();
  try {
    const before = readFileSync(join(dir, 'a.md'), 'utf8');
    const { code, out } = run(['--bundle', dir]);
    assert.equal(code, 0);
    assert.match(out, /a\.md/);
    assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), before, 'default run must not modify files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--write bumps the timestamp of a drifting concept', () => {
  const dir = makeBundle();
  try {
    const { code } = run(['--bundle', dir, '--write']);
    assert.equal(code, 0);
    const after = readFileSync(join(dir, 'a.md'), 'utf8');
    assert.doesNotMatch(after, /2001-01-01/, 'stale timestamp should have been replaced');
    assert.match(after, /^timestamp: \d{4}-\d{2}-\d{2}T/m, 'a valid ISO-8601 timestamp should be written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--write preserves every other front-matter field and the body', () => {
  const dir = makeBundle();
  try {
    run(['--bundle', dir, '--write']);
    const after = readFileSync(join(dir, 'a.md'), 'utf8');
    assert.match(after, /^type: R$/m);
    assert.match(after, /^resource: README\.md$/m);
    assert.match(after, /\nbody\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a concept with no timestamp is never given one', () => {
  // Adding a timestamp would silently opt that page into drift tracking it never had.
  const dir = makeBundle();
  try {
    run(['--bundle', dir, '--write']);
    assert.doesNotMatch(readFileSync(join(dir, 'b.md'), 'utf8'), /timestamp:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bumping clears the drift signal', () => {
  const dir = makeBundle();
  try {
    run(['--bundle', dir, '--write']);
    const gate = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-openwiki-okf.mjs'), '--bundle', dir, '--json'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    const parsed = JSON.parse(gate.stdout);
    assert.equal(parsed.warnings.filter((w) => w.rule === 'V12').length, 0, 'drift should be cleared');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clean bundle is a no-op and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'okf-ts-clean-'));
  try {
    writeFileSync(join(dir, 'index.md'), '---\ntype: Reference\n---\n# I\n- [a](a.md)\n');
    writeFileSync(join(dir, 'a.md'), '---\ntype: R\n---\nbody\n');
    const { code, out } = run(['--bundle', dir, '--write']);
    assert.equal(code, 0);
    assert.match(out, /no drifting concepts|nothing to refresh/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--selftest passes', () => {
  const { code } = run(['--selftest']);
  assert.equal(code, 0);
});

test('an unknown argument exits 2', () => {
  const { code } = run(['--nope']);
  assert.equal(code, 2);
});
