// The session refresh tool, `scripts/wiki-refresh.mjs` (feature 098, contracts/wiki-refresh-cli.md).
// Drives the real CLI as a subprocess inside a throwaway `git init` repository, so `--diff` is tested
// against real history with pinned commit dates, and nothing here reads or writes the real tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(REPO_ROOT, 'scripts', 'wiki-refresh.mjs');
const { staleDerivedPages } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'openwiki-fingerprint.mjs')).href);

const sha = (s) => createHash('sha256').update(s).digest('hex');

const V0 = '# Runbook\n\nstep zero\n';
const V1 = '# Runbook\n\nstep zero\nstep one\n';
const V2 = '# Runbook\n\nstep zero\nstep one\nstep two added later\n';

function git(root, args, date) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function write(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function commit(root, message, date) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--allow-empty', '-m', message], date);
}

const page = (extra = '', resource = 'docs/run.md') =>
  `---\ntype: Runbook\ntitle: Run\nresource: ${resource}\ntags: [a]\n${extra}---\n# Run\n\nThe body says step one.\n`;

/**
 * A repo whose source went V0 (2026-01-01) → V1 (2026-02-01) → V2 (2026-03-01). `fresh.md` recorded
 * V1's fingerprint; `unrecorded.md` has none but was stamped 2026-02-15, between V1 and V2.
 */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-refresh-'));
  git(root, ['init', '-q', '-b', 'main']);
  write(root, 'docs/run.md', V0);
  commit(root, 'v0', '2026-01-01T00:00:00Z');
  write(root, 'docs/run.md', V1);
  write(root, 'openwiki/runbooks/fresh.md', page(`resource-sha256: ${sha(V1)}\ntimestamp: 2026-02-01T12:00:00Z\n`));
  write(root, 'openwiki/runbooks/unrecorded.md', page('generated: { by: "openwiki/0.6.0", at: "2026-02-15T00:00:00Z" }\nsources:\n  - id: openwiki-source-1\n    resource: repo://docs/run.md\nverified:\n  - by: openwiki/0.6.0\n    at: 2026-02-15T00:00:00Z\n'));
  write(root, 'openwiki/invariants/canon.md', '---\ntype: Invariant\ntitle: Canon\n---\n# Canon\n');
  commit(root, 'v1', '2026-02-01T00:00:00Z');
  write(root, 'docs/run.md', V2);
  commit(root, 'v2', '2026-03-01T00:00:00Z');
  return root;
}

const run = (root, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};

const status = (root) => git(root, ['status', '--porcelain']);

// ── --stale ─────────────────────────────────────────────────────────────────────

test('--stale prints exactly what staleDerivedPages reports, and exits 1 when anything is stale', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = run(root, ['--stale']);
  assert.equal(r.code, 1, r.err);
  const expected = staleDerivedPages({ root }).map((s) => `${s.page} ← ${s.resource}  (${s.reason})`);
  assert.deepEqual(expected, [
    'openwiki/runbooks/fresh.md ← docs/run.md  (source changed)',
    'openwiki/runbooks/unrecorded.md ← docs/run.md  (no fingerprint)',
  ]);
  assert.deepEqual(r.out.trim().split('\n'), expected);
  assert.equal(status(root), '', '--stale writes nothing');
});

test('--stale exits 0 and prints nothing on a clean bundle', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  rmSync(join(root, 'openwiki/runbooks/unrecorded.md'));
  write(root, 'openwiki/runbooks/fresh.md', page(`resource-sha256: ${sha(V2)}\n`));
  const r = run(root, ['--stale']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
});

test('--stale --json has the documented shape', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = run(root, ['--stale', '--json']);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out), {
    stale: [
      { page: 'openwiki/runbooks/fresh.md', resource: 'docs/run.md', reason: 'source changed' },
      { page: 'openwiki/runbooks/unrecorded.md', resource: 'docs/run.md', reason: 'no fingerprint' },
    ],
  });
});

// ── --diff ──────────────────────────────────────────────────────────────────────

test('--diff shows only the change since the commit whose bytes match the recorded hash', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = run(root, ['--diff', 'openwiki/runbooks/fresh.md']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /base: [0-9a-f]{7,} \(matches the recorded resource-sha256\)/);
  assert.match(r.out, /^\+step two added later$/m);
  assert.doesNotMatch(r.out, /^\+step one$/m, 'V0→V1 is already in the page; it must not be shown again');
  assert.equal(status(root), '', '--diff writes nothing');
});

test('--diff with no fingerprint diffs from the newest resource commit at or before the page stamp, and labels it', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = run(root, ['--diff', 'openwiki/runbooks/unrecorded.md']);
  assert.equal(r.code, 0, r.err);
  // `generated.at` is 2026-02-15; V1 (2026-02-01) is the newest commit at or before it.
  assert.match(r.out, /base: commit at page stamp 2026-02-15T00:00:00Z \([0-9a-f]{7,}\)/);
  assert.match(r.out, /^\+step two added later$/m);
  assert.doesNotMatch(r.out, /^\+step one$/m);
});

test('--diff falls back to the whole file, with a notice, only when neither base exists', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A corrupted hash, and a stamp older than the source's first commit.
  write(root, 'openwiki/runbooks/orphan.md', page(`resource-sha256: ${sha('never existed')}\ntimestamp: 2025-01-01T00:00:00Z\n`));
  const r = run(root, ['--diff', 'openwiki/runbooks/orphan.md']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /base: none/);
  assert.match(r.out, /whole file/);
  assert.ok(r.out.includes(V2), 'the whole current source is printed');
});

test('--diff refuses a canonical page with exit 2', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(run(root, ['--diff', 'openwiki/invariants/canon.md']).code, 2);
});

// ── --record ────────────────────────────────────────────────────────────────────

test('--record changes only resource-sha256 and timestamp, strips sources/verified, leaves the body byte-identical', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pagePath = 'openwiki/runbooks/unrecorded.md';
  const before = readFileSync(join(root, pagePath), 'utf8');
  const r = run(root, ['--record', pagePath]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^recorded ${pagePath} ${sha(V2).slice(0, 12)}$`, 'm'));

  const after = readFileSync(join(root, pagePath), 'utf8');
  const body = (s) => s.slice(s.indexOf('\n---\n'));
  assert.equal(body(after), body(before), 'body is byte-identical');

  const diff = git(root, ['diff', '-U0', '--', pagePath]).split('\n').filter((l) => /^[+-][^+-]/.test(l));
  const added = diff.filter((l) => l.startsWith('+'));
  const removed = diff.filter((l) => l.startsWith('-'));
  assert.deepEqual(added.map((l) => l.split(':')[0]), ['+resource-sha256', '+timestamp']);
  assert.ok(removed.every((l) => /^-(sources:|verified:|\s)/.test(l)), `only sources/verified removed:\n${removed.join('\n')}`);
  assert.ok(removed.some((l) => l.startsWith('-sources:')) && removed.some((l) => l.startsWith('-verified:')));
  assert.deepEqual(staleDerivedPages({ root }).map((s) => s.page), ['openwiki/runbooks/fresh.md']);
});

test('--record exits 2 for a canonical or non-existent page, and writes nothing', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(run(root, ['--record', 'openwiki/invariants/canon.md']).code, 2);
  assert.equal(run(root, ['--record', 'openwiki/runbooks/fresh.md', 'openwiki/runbooks/nope.md']).code, 2);
  assert.equal(status(root), '', 'a refused --record writes nothing, not even the valid page');
});

// ── the argument contract ───────────────────────────────────────────────────────

test('an unknown flag exits 2 and writes nothing', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [['--recrod', 'openwiki/runbooks/fresh.md'], ['--record', '--all-fresh'], ['--stale', '--dry-run'], []]) {
    const r = run(root, args);
    assert.equal(r.code, 2, `${args.join(' ')} → ${r.code}\n${r.out}${r.err}`);
  }
  assert.equal(status(root), '');
});

test('--help exits 0, names every flag, and writes nothing', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = run(root, ['--record', '--help']);
  assert.equal(r.code, 0);
  for (const flag of ['--stale', '--json', '--diff', '--record', '--help']) assert.ok(r.out.includes(flag), flag);
  assert.equal(status(root), '');
});
