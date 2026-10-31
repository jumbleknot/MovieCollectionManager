// Item #879 — unit tests for the merged-branch reaper's pure logic.
//
// Each keep-reason has its own test, and each is written so that DELETING the corresponding check in
// selectReapable() turns it red — that is the mutation coverage the item asks for: a reaper whose
// ancestor check, open-PR check, exempt list or grace period silently went missing would delete
// branches it must not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  selectReapable,
  collectOpenPrHeads,
  resolveCommand,
  EXEMPT,
  GRACE_MS,
} from '../reap-merged-branches.mjs';
import { ArgvError } from '../lib/argv-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-10-30T12:00:00Z');
const OLD = new Date(NOW.getTime() - GRACE_MS - 60_000);
const FRESH = new Date(NOW.getTime() - 60_000);
const br = (name, tipDate = OLD) => ({ name, sha: `${name.length}`.padEnd(40, 'a'), tipDate });

function run(branches, { open = [], ancestors = null, exempt = EXEMPT } = {}) {
  const anc = ancestors ?? Object.fromEntries(branches.map((b) => [b.name, true]));
  return selectReapable(branches, {
    openPrHeads: new Set(open),
    isAncestor: (n) => anc[n],
    exempt,
    now: NOW,
  });
}
const reasonOf = (res, name) => res.keep.find((k) => k.name === name)?.reason;

// ── selectReapable ───────────────────────────────────────────────────────────

test('a merged, old, unused branch is reaped — with the sha it was classified at', () => {
  const res = run([br('feature-x')]);
  assert.deepEqual(res.reap, [{ name: 'feature-x', sha: br('feature-x').sha }]);
  assert.deepEqual(res.keep, []);
});

test('MUTATION (ancestor check): a branch NOT merged into main is kept', () => {
  const res = run([br('wip')], { ancestors: { wip: false } });
  assert.deepEqual(res.reap, []);
  assert.equal(reasonOf(res, 'wip'), 'not merged into main');
});

test('ancestry that cannot be answered keeps the branch rather than guessing', () => {
  for (const unanswerable of [null, undefined]) {
    const res = run([br('shallow')], { ancestors: { shallow: unanswerable } });
    assert.deepEqual(res.reap, []);
    assert.equal(reasonOf(res, 'shallow'), 'ancestry unanswerable');
  }
});

test('MUTATION (open-PR check): the head of an open PR is kept even when merged — the #874–#877 shape', () => {
  const res = run([br('renovate/lock-file-maintenance')], { open: ['renovate/lock-file-maintenance'] });
  assert.deepEqual(res.reap, []);
  assert.equal(reasonOf(res, 'renovate/lock-file-maintenance'), 'head of an open PR');
});

test('MUTATION (exempt list): main and automation-owned branches are never reaped', () => {
  const res = run([br('main'), br('openwiki-maintenance')]);
  assert.deepEqual(res.reap, []);
  assert.equal(reasonOf(res, 'main'), 'exempt');
  assert.equal(reasonOf(res, 'openwiki-maintenance'), 'exempt');
});

test('the default exempt list names main and openwiki-maintenance', () => {
  assert.ok(EXEMPT.has('main'));
  assert.ok(EXEMPT.has('openwiki-maintenance'));
});

test('MUTATION (grace period): a merged branch whose tip is younger than the grace period is kept', () => {
  const res = run([br('just-merged', FRESH)]);
  assert.deepEqual(res.reap, []);
  assert.equal(reasonOf(res, 'just-merged'), 'inside grace period');
});

test('the grace period is a few hours, not zero and not days', () => {
  assert.ok(GRACE_MS >= 60 * 60 * 1000, 'under an hour would race a concurrent session');
  assert.ok(GRACE_MS <= 24 * 60 * 60 * 1000, 'over a day would let a stale renovate branch reach the next window');
});

test('an unreadable tip date keeps the branch', () => {
  const res = run([br('weird', new Date('not a date'))]);
  assert.deepEqual(res.reap, []);
  assert.equal(reasonOf(res, 'weird'), 'tip date unreadable');
});

test('a mixed set is split correctly, branch by branch', () => {
  const res = run(
    [br('main'), br('done-a'), br('done-b'), br('wip', OLD), br('pr-head'), br('fresh', FRESH)],
    { open: ['pr-head'], ancestors: { main: true, 'done-a': true, 'done-b': true, wip: false, 'pr-head': true, fresh: true } },
  );
  assert.deepEqual(res.reap.map((r) => r.name), ['done-a', 'done-b']);
  assert.equal(res.keep.length, 4);
});

// ── collectOpenPrHeads — fail closed ─────────────────────────────────────────

const pr = (ref) => ({ head: { ref } });

test('open-PR heads are collected across pages', async () => {
  const pages = { 1: Array.from({ length: 50 }, (_, i) => pr(`b${i}`)), 2: [pr('b50')] };
  const heads = await collectOpenPrHeads(async (p) => ({ rows: pages[p] ?? [], total: '51' }));
  assert.equal(heads.size, 51);
  assert.ok(heads.has('b50'));
});

test('a listing short of its x-total-count THROWS — never "fewer open PRs"', async () => {
  await assert.rejects(
    collectOpenPrHeads(async () => ({ rows: [pr('a')], total: '2' })),
    /1 rows against x-total-count 2/,
  );
});

test('a listing with no x-total-count THROWS — completeness cannot be proven', async () => {
  await assert.rejects(collectOpenPrHeads(async () => ({ rows: [], total: null })), /no x-total-count/);
});

test('a failed page read propagates rather than reading as an empty listing', async () => {
  await assert.rejects(
    collectOpenPrHeads(async () => {
      throw new Error('GET open pulls page 1 → 403');
    }),
    /403/,
  );
});

test('a non-list page THROWS', async () => {
  await assert.rejects(collectOpenPrHeads(async () => ({ rows: { message: 'nope' }, total: '0' })), /not a list/);
});

test('zero open PRs is a valid, complete answer', async () => {
  const heads = await collectOpenPrHeads(async () => ({ rows: [], total: '0' }));
  assert.equal(heads.size, 0);
});

// ── the argument contract ────────────────────────────────────────────────────

test('a bare invocation is a DRY RUN — deleting needs --apply', () => {
  assert.equal(resolveCommand([]).command, 'dry-run');
  assert.equal(resolveCommand(['--apply']).command, 'apply');
});

test('--help wins outright, even beside --apply', () => {
  assert.equal(resolveCommand(['--apply', '--help']).command, 'help');
  assert.equal(resolveCommand(['-h']).command, 'help');
});

test('near-miss spellings of --apply are REJECTED, not read as a dry run or an apply', () => {
  for (const typo of ['--aply', '-apply', '--Apply', '--dry-run', '--force']) {
    assert.throws(() => resolveCommand([typo]), ArgvError, typo);
  }
});

test('a positional argument is rejected', () => {
  assert.throws(() => resolveCommand(['main']), ArgvError);
});

// ── wiring guards ────────────────────────────────────────────────────────────

const SCRIPT = readFileSync(resolve(ROOT, 'scripts/reap-merged-branches.mjs'), 'utf8');
// Comments stripped: the guards are about what the workflow DOES, and its header names the very
// credential it refuses — a comment must neither satisfy nor trip an assertion.
const WORKFLOW = readFileSync(resolve(ROOT, '.forgejo/workflows/branch-reaper.yml'), 'utf8')
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .map((l) => l.replace(/\s+#.*$/, ''))
  .join('\n');

test('the delete is LEASED to the classified sha — an unmerged commit pushed meanwhile is never destroyed', () => {
  assert.match(SCRIPT, /--force-with-lease=refs\/heads\/\$\{r\.name\}:\$\{r\.sha\}/);
});

test('the workflow runs --apply, on push to main AND a schedule, with full history for ancestry', () => {
  assert.match(WORKFLOW, /node scripts\/reap-merged-branches\.mjs --apply/);
  assert.match(WORKFLOW, /push:\s*\n\s*branches:\s*\[\s*main\s*\]/);
  assert.match(WORKFLOW, /schedule:\s*\n\s*- cron:/);
  assert.match(WORKFLOW, /fetch-depth:\s*0/);
});

test('the workflow does not hand the reaper a credential that can push to main', () => {
  assert.doesNotMatch(WORKFLOW, /CD_PUSH_TOKEN/);
});
