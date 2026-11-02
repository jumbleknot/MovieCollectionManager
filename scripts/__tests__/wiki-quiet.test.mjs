// Feature 078 research R19 / item #613 — wait for `main` to go quiet OUTSIDE the job.
//
// The debounce used to be a `sleep 900` inside the merge-triggered job, which spent 15 of its 60
// minutes waiting and left generation ~37. Now a scheduled check decides from git, before any
// install, whether main has been quiet for DEBOUNCE_SECONDS — and either generates at once or ends.
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

import {
  maintenanceTrigger, isOwnCommit, uncoveredCommits, DEBOUNCE_SECONDS, MAX_DEFERRAL_SECONDS,
} from '../wiki-quiet.mjs';

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

test('trigger: a real commit under the quiet period is not yet', () => {
  const d = maintenanceTrigger({ commits: [commit(DEBOUNCE_SECONDS - 1), commit(2 * 3600)], nowSeconds: NOW });
  assert.equal(d.run, false, d.reason);
  assert.match(d.reason, /not quiet|not yet/i);
});

test('trigger: the newest real commit at the quiet period runs — at, not only past', () => {
  const d = maintenanceTrigger({ commits: [commit(DEBOUNCE_SECONDS), commit(3600)], nowSeconds: NOW });
  assert.equal(d.run, true, d.reason);
});

test("trigger: the job's own fresh commit does not hold back a quiet main", () => {
  const d = maintenanceTrigger({
    commits: [commit(30, { message: 'chore: marker [skip ci]' }), commit(DEBOUNCE_SECONDS + 60)],
    nowSeconds: NOW,
  });
  assert.equal(d.run, true, d.reason);
});

test('trigger: a main that never goes quiet still runs at the maximum deferral (SC-008b)', () => {
  const d = maintenanceTrigger({ commits: [commit(10), commit(MAX_DEFERRAL_SECONDS)], nowSeconds: NOW });
  assert.equal(d.run, true, d.reason);
  assert.match(d.reason, /deferral/);
  assert.equal(maintenanceTrigger({ commits: [commit(10), commit(MAX_DEFERRAL_SECONDS - 1)], nowSeconds: NOW }).run, false);
  assert.ok(MAX_DEFERRAL_SECONDS > DEBOUNCE_SECONDS, 'the ceiling must be longer than the quiet period it overrides');
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
