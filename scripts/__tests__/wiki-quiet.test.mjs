// Feature 078 research R19 / item #613 — wait for `main` to go quiet OUTSIDE the job.
//
// The debounce used to be a `sleep 900` inside the merge-triggered job, which spent 15 of its 60
// minutes waiting and left generation ~37. Now a scheduled check decides from git, before any
// install, whether anything real is uncovered — and either generates at once or ends. Since 078 US7
// (2026-11-09) the fire is daily and there is no debounce: any real commit runs.
//
// The decision is pure (commit fixtures, no git); the git read and the CLI are checked against a
// temporary repository, because "a git failure reads as nothing to do" is the one way this design
// could silently end maintenance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import * as QUIET from '../wiki-quiet.mjs';

const { maintenanceTrigger, isOwnCommit, uncoveredCommits } = QUIET;

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'wiki-quiet.mjs');
const NOW = 1_800_000_000;
const commit = (ageSeconds, { message = 'feat: something', files = ['scripts/x.mjs'] } = {}) =>
  ({ sha: `c${ageSeconds}`, time: NOW - ageSeconds, message, files });

// ── the decision ──────────────────────────────────────────────────────────────────────────────

test('trigger: nothing uncovered is no run', () => {
  assert.equal(maintenanceTrigger({ commits: [], nowSeconds: NOW }).run, false);
});

test("trigger: only the job's own commits is no run — they never started a push run either", () => {
  const own = [
    commit(60, { message: 'chore(openwiki): advance the maintenance marker [skip ci]', files: ['openwiki/.maintenance-state.json'] }),
    commit(7 * 3600, { message: 'chore(cd): promote abc image digest(s) [skip ci]', files: ['infrastructure-as-code/x.env'] }),
    commit(120, { message: 'Merge pull request #1 from openwiki-maintenance', files: ['openwiki/a.md', 'openwiki/b.md'] }),
  ];
  const d = maintenanceTrigger({ commits: own, nowSeconds: NOW });
  assert.equal(d.run, false, d.reason);
});

test('trigger: a real commit of ANY age runs — the daily fire is the batching, there is no debounce (078 FR-024)', () => {
  for (const age of [1, 60, 15 * 60, 6 * 3600, 3 * 86400]) {
    const d = maintenanceTrigger({ commits: [commit(age)], nowSeconds: NOW });
    assert.equal(d.run, true, `a ${age}-s-old commit: ${d.reason}`);
  }
});

test("trigger: the job's own fresh commit beside a real one still runs", () => {
  const d = maintenanceTrigger({
    commits: [commit(30, { message: 'chore: marker [skip ci]' }), commit(5)],
    nowSeconds: NOW,
  });
  assert.equal(d.run, true, d.reason);
  assert.match(d.reason, /1 real/);
});

test('trigger: the retired debounce and deferral constants are gone, so nothing can quietly reinstate them (078 FR-024)', () => {
  assert.ok(!('DEBOUNCE_SECONDS' in QUIET), 'DEBOUNCE_SECONDS is still exported');
  assert.ok(!('MAX_DEFERRAL_SECONDS' in QUIET), 'MAX_DEFERRAL_SECONDS is still exported');
});

test('trigger: a dispatch runs whatever main is doing (FR-009c)', () => {
  assert.equal(maintenanceTrigger({ commits: [commit(1)], nowSeconds: NOW, dispatched: true }).run, true);
  assert.equal(maintenanceTrigger({ commits: [], nowSeconds: NOW, dispatched: true }).run, true);
});

test("own commit: [skip ci] anywhere in the message, or a change only under openwiki/", () => {
  assert.equal(isOwnCommit({ message: 'x\n\n[skip ci]', files: ['a'] }), true);
  assert.equal(isOwnCommit({ message: 'x', files: ['openwiki/a.md', 'openwiki/.claims/a.json'] }), true);
  assert.equal(isOwnCommit({ message: 'x', files: ['openwiki/a.md', 'docs/runbooks/a.md'] }), false);
  // An empty file list is NOT bundle-only: a commit whose diff could not be read is real work.
  assert.equal(isOwnCommit({ message: 'x', files: [] }), false);
});

// ── the git read, on a real repository ─────────────────────────────────────────────────────────

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-quiet-'));
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  write('a.txt', '1'); git('add', '-A'); git('commit', '-qm', 'base');
  return { dir, git, write };
}

test('git: lists the first-parent commits past coveredCommit, with their files', () => {
  const { dir, git, write } = repo();
  const covered = git('rev-parse', 'HEAD');
  write('openwiki/p.md', 'x'); git('add', '-A'); git('commit', '-qm', 'bundle only');
  write('b.txt', '2'); git('add', '-A'); git('commit', '-qm', 'real [skip ci]');
  write('c.txt', '3'); git('add', '-A'); git('commit', '-qm', 'real');
  const got = uncoveredCommits({ root: dir, coveredCommit: covered });
  assert.deepEqual(got.map((c) => c.message.split('\n')[0]), ['real', 'real [skip ci]', 'bundle only']);
  assert.deepEqual(got.find((c) => c.message.startsWith('bundle')).files, ['openwiki/p.md']);
  assert.ok(got.every((c) => Number.isInteger(c.time) && c.time > 0));
});

test('git: an unknown coveredCommit RAISES — never "nothing to do", which would end maintenance silently', () => {
  const { dir } = repo();
  assert.throws(() => uncoveredCommits({ root: dir, coveredCommit: 'f'.repeat(40) }), /coveredCommit/);
});

// ── the CLI ───────────────────────────────────────────────────────────────────────────────────

test('cli: prints run=<bool> on stdout and the reason on stderr; an unknown flag exits 2', () => {
  const { dir, git } = repo();
  mkdirSync(join(dir, 'openwiki'), { recursive: true });
  writeFileSync(join(dir, 'openwiki', '.maintenance-state.json'), JSON.stringify({ coveredCommit: git('rev-parse', 'HEAD') }));
  const ok = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'run=false');
  assert.match(ok.stderr, /nothing uncovered/);
  const disp = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--dispatched'], { encoding: 'utf8' });
  assert.equal(disp.stdout.trim(), 'run=true');
  const bad = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--dispatch'], { encoding: 'utf8' });
  assert.equal(bad.status, 2, 'a typo must be refused, not read as a scheduled check');
  assert.equal(bad.stdout, '');
});

test('cli: a missing run record is a loud failure, not run=false', () => {
  const { dir } = repo();
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
});
