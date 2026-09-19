// Item #311 — unit tests for the weekly Renovate health digest's pure logic.
//
// The digest exists because Renovate's failure mode on this forge is ABSENCE (a dead channel, a
// stale branch, a spent budget), and absence is unreadable — items #153/#218/#268/#290 were each
// discovered late for exactly that reason. These tests pin the classification logic; the I/O shell
// follows check-lockfile-refresh.mjs (comment-only, always exit 0) and is deliberately thin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRepositoryProblems,
  classifyRenovateBranches,
  budget,
  stabilityRows,
  buildDigest,
  blockedRequiredRows,
  selectNewestScheduledRun,
  sweepVerdict,
} from '../renovate-health.mjs';

// ── parseRepositoryProblems ──────────────────────────────────────────────────

test('repository problems are read from the dashboard section, warnings only', () => {
  const body = [
    '## Repository problems',
    '',
    'These problems occurred while renovating this repository.',
    '',
    ' - ⚠️ WARN: execa promise rejection suppressed',
    ' - ℹ️ INFO: something routine',
    '',
    '## Awaiting Schedule',
    ' - [ ] <!-- unschedule-branch=renovate/x -->chore',
  ].join('\n');
  assert.deepEqual(parseRepositoryProblems(body), ['⚠️ WARN: execa promise rejection suppressed']);
});

test('a dashboard without a problems section reports none — and does not misread other sections', () => {
  assert.deepEqual(parseRepositoryProblems('## Open\n - [ ] tick'), []);
  assert.deepEqual(parseRepositoryProblems(''), []);
  assert.deepEqual(parseRepositoryProblems(null), []);
});

// ── classifyRenovateBranches ─────────────────────────────────────────────────

const ancestryOf = (map) => (branch) => map[branch] ?? null;

test('an ancestor branch with an open PR is an EMPTY PR — the #288 shape', () => {
  const out = classifyRenovateBranches(
    ['renovate/js-patchminor', 'main'],
    new Set(['renovate/js-patchminor']),
    ancestryOf({ 'renovate/js-patchminor': true }),
  );
  assert.deepEqual(out.emptyPr, ['renovate/js-patchminor']);
  assert.deepEqual(out.stale, []);
  assert.deepEqual(out.active, []);
});

test('an ancestor branch with NO open PR is a stale ref — the #290 class the repo setting cannot fully close', () => {
  const out = classifyRenovateBranches(
    ['renovate/lock-file-maintenance'],
    new Set(),
    ancestryOf({ 'renovate/lock-file-maintenance': true }),
  );
  assert.deepEqual(out.stale, ['renovate/lock-file-maintenance']);
});

test('a non-ancestor branch is active pending work, and non-renovate branches are ignored', () => {
  const out = classifyRenovateBranches(
    ['renovate/nx-monorepo', 'feature/foo', 'main'],
    new Set(['renovate/nx-monorepo']),
    ancestryOf({ 'renovate/nx-monorepo': false }),
  );
  assert.deepEqual(out.active, ['renovate/nx-monorepo']);
  assert.deepEqual(out.emptyPr, []);
  assert.deepEqual(out.stale, []);
});

test('an unanswerable ancestry check is reported as unknown, never silently dropped', () => {
  const out = classifyRenovateBranches(['renovate/x'], new Set(), ancestryOf({}));
  assert.deepEqual(out.unknown, ['renovate/x']);
});

// ── budget ───────────────────────────────────────────────────────────────────

test('open Renovate PRs consume prConcurrentLimit headroom', () => {
  const b = budget({ prConcurrentLimit: 5 }, [{ number: 1 }, { number: 2 }]);
  assert.equal(b.limit, 5);
  assert.equal(b.open, 2);
  assert.equal(b.headroom, 3);
});

// ── stabilityRows ────────────────────────────────────────────────────────────

test('the stability-days context is read per PR, and its absence is reported as such', () => {
  const rows = stabilityRows(
    [
      { number: 263, title: 'js patch/minor', head: { sha: 'aaa' }, created_at: '2026-08-28T07:08:43Z' },
      { number: 999, title: 'docker base images', head: { sha: 'bbb' }, created_at: '2026-09-04T07:05:00Z' },
    ],
    { aaa: [{ context: 'renovate/stability-days', status: 'pending' }], bbb: [] },
  );
  assert.deepEqual(rows.map((r) => [r.number, r.stability]), [[263, 'pending'], [999, 'absent']]);
});

// ── buildDigest ──────────────────────────────────────────────────────────────

test('a fully healthy week renders the one-line heartbeat, so silence means the JOB died', () => {
  // UPDATED AT THE CAUSE, item #485 — not relaxed. This case used to pass WITHOUT stating the
  // weekly sweep or the required set, because "healthy" was decided by four branch/dashboard
  // counters alone. That is precisely the hole: on 2026-09-18 the real digest printed this same
  // ✅ line while `main` had been failing a required gate for five hours. A healthy week must now
  // SAY that the sweep is green and that protection was readable, so a caller that never looked
  // cannot reach this line by omission.
  const md = buildDigest({
    problems: [],
    branches: { emptyPr: [], stale: [], active: ['renovate/nx-monorepo'], unknown: [] },
    budgetInfo: { limit: 5, open: 1, headroom: 4 },
    rows: [{ number: 1, title: 't', stability: 'success', created_at: '2026-08-28T00:00:00Z' }],
    blocked: [],
    sweep: { state: 'success', text: 'run 3073 is success' },
    requiredGlobs: ['app-ci / *'],
  });
  assert.match(md, /✅/);
  assert.doesNotMatch(md, /⚠️|❌/);
});

test('(#485) omitting the sweep and protection reads is NOT a healthy week', () => {
  // The companion to the case above, and the reason it had to change. The old signature let a
  // caller that never performed either read still render ✅. Fail closed instead: unknown is not a
  // pass, at either layer.
  const md = buildDigest({
    problems: [],
    branches: { emptyPr: [], stale: [], active: [], unknown: [] },
    budgetInfo: { limit: 5, open: 0, headroom: 5 },
    rows: [],
  });
  assert.doesNotMatch(md, /✅/, 'a digest that looked at neither signal must not claim health');
});

test('every anomaly class is surfaced, with the runbook action it maps to', () => {
  // The two item #485 signals are held CLEAN here on purpose: this case is about the branch and
  // dashboard classes, and letting the new counters supply its anomalies would make it pass even if
  // every assertion below stopped being rendered.
  const md = buildDigest({
    problems: ['⚠️ WARN: execa promise rejection suppressed'],
    branches: { emptyPr: ['renovate/a'], stale: ['renovate/b'], active: [], unknown: ['renovate/c'] },
    budgetInfo: { limit: 5, open: 5, headroom: 0 },
    rows: [{ number: 7, title: 'x', stability: 'pending', created_at: '2026-08-01T00:00:00Z' }],
    blocked: [],
    sweep: { state: 'success', text: 'run 3073 is success' },
    requiredGlobs: ['app-ci / *'],
  });
  assert.match(md, /execa promise rejection suppressed/); // dead channel — §5
  assert.match(md, /renovate\/a/); // empty PR — §2
  assert.match(md, /renovate\/b/); // stale ref — §2
  assert.match(md, /renovate\/c/); // unknown ancestry — never silently dropped
  assert.match(md, /headroom.*0|0.*headroom/i); // budget exhausted — §1
  assert.match(md, /stability-days/);
});

// ── Item #485 — the digest said "✅ Healthy" while `main` was five hours into a red required gate ─
//
// Run 3562 posted "✅ Healthy" to item #311 at 2026-09-18T11:57:15Z. At that moment the weekly sweep
// on `main` (run 3521) had been FAILURE since 07:02:22Z, and PR #478 — unmergeable on exactly that
// failure — was listed in a table whose only verdict column read `success`. The digest read the one
// ADVISORY check (`renovate/stability-days`) and never the required set.
//
// These tests pin both halves: the required-context read, and the sweep read.

const HEALTHY = { problems: [], branches: { emptyPr: [], stale: [], active: [], unknown: [] } };
const CLEAN = {
  ...HEALTHY,
  budgetInfo: { limit: 5, open: 0, headroom: 5 },
  rows: [],
  blocked: [],
  sweep: { state: 'success', text: 'run 3073 is success' },
  requiredGlobs: ['app-ci / *', 'infra-image-scan / infra-image-scan*'],
};

// ── blockedRequiredRows ──────────────────────────────────────────────────────

const PR = (number, sha, title = 'chore(deps): pin dependencies') => ({ number, title, head: { sha } });
const status = (context, state) => ({ context, status: state, created_at: '2026-09-18T07:43:44Z' });

test('(#485) a PR blocked by a REQUIRED context is reported, whatever stability-days says', () => {
  // The #478 shape exactly: the advisory check passed and the required sweep failed.
  const rows = blockedRequiredRows(
    [PR(478, 'aaa')],
    { aaa: [status('renovate/stability-days', 'success'), status('infra-image-scan / infra-image-scan', 'failure')] },
    ['infra-image-scan / infra-image-scan*'],
  );
  assert.equal(rows.length, 1, 'PR #478 is unmergeable on a required context and must be reported');
  assert.equal(rows[0].number, 478);
  assert.ok(rows[0].contexts.some((c) => c.includes('infra-image-scan')), 'the row must name the blocking context');
});

test('(#485) a failing ADVISORY context does not make a PR blocked — the control', () => {
  // Without this, the assertion above is satisfied by a function that flags every PR with any red
  // context, which would turn the digest into noise and retrain people to ignore it.
  const rows = blockedRequiredRows(
    [PR(479, 'bbb')],
    { bbb: [status('renovate/stability-days', 'failure'), status('infra-image-scan / infra-image-scan', 'success')] },
    ['infra-image-scan / infra-image-scan*'],
  );
  assert.deepEqual(rows, [], 'stability-days is advisory; a red one does not block a merge');
});

test('(#485) an unreadable protection payload yields no rows — and never a clean answer', () => {
  // null means "could not read". Manufacturing [] here would render "nothing is blocked", which is
  // the absence-reads-as-health fault this file exists to prevent. buildDigest counts it separately.
  assert.deepEqual(blockedRequiredRows([PR(1, 'ccc')], { ccc: [status('x / y', 'failure')] }, null), []);
  assert.deepEqual(blockedRequiredRows([PR(1, 'ccc')], { ccc: [status('x / y', 'failure')] }, []), []);
});

// ── selectNewestScheduledRun — the item #418 trap ────────────────────────────

test('(#485) the sweep is found by trigger_event, NOT by the `event` field', () => {
  // THE TRAP, measured over all 68 scheduled runs since 2026-07-31 and re-measured 2026-09-19: the
  // runs API reports `event` = "push" on EVERY scheduled run. `trigger_event` carries the truth.
  // A reader that filters on `event` finds nothing and concludes the sweep never ran — which is the
  // wrong conclusion item #418 nearly shipped.
  const runs = [
    { id: 3615, workflow_id: 'app-ci.yml', trigger_event: 'push', event: 'push', status: 'success', started: '2026-09-19T01:00:00Z' },
    { id: 3521, workflow_id: 'infra-image-scan.yml', trigger_event: 'schedule', event: 'push', status: 'failure', started: '2026-09-18T07:02:22Z' },
    { id: 3500, workflow_id: 'infra-image-scan.yml', trigger_event: 'pull_request', event: 'pull_request', status: 'success', started: '2026-09-18T09:00:00Z' },
  ];
  const run = selectNewestScheduledRun(runs, 'infra-image-scan.yml');
  assert.equal(run?.id, 3521, 'the scheduled sweep must be found despite event="push"');
});

test('(#485) another workflow’s scheduled run is not mistaken for the sweep', () => {
  const runs = [{ id: 1, workflow_id: 'wiki-maintain.yml', trigger_event: 'schedule', status: 'failure', started: '2026-09-18T07:00:00Z' }];
  assert.equal(selectNewestScheduledRun(runs, 'infra-image-scan.yml'), null);
});

test('(#485) the NEWEST scheduled run wins even if the page is out of order', () => {
  const runs = [
    { id: 1948, workflow_id: 'infra-image-scan.yml', trigger_event: 'schedule', status: 'failure', started: '2026-08-21T07:09:56Z' },
    { id: 3521, workflow_id: 'infra-image-scan.yml', trigger_event: 'schedule', status: 'failure', started: '2026-09-18T07:02:22Z' },
  ];
  assert.equal(selectNewestScheduledRun(runs, 'infra-image-scan.yml')?.id, 3521);
});

// ── sweepVerdict ─────────────────────────────────────────────────────────────

test('(#485) `status` carries the verdict on this forge, and a missing run is UNKNOWN not a pass', () => {
  assert.equal(sweepVerdict({ id: 3521, status: 'failure', started: 'x', commit_sha: '3cbe637e00' }).state, 'failure');
  assert.equal(sweepVerdict({ id: 3073, status: 'success', started: 'x', commit_sha: '1c1bd5b500' }).state, 'success');
  // The load-bearing one. "I could not find the sweep" must never render as green.
  assert.equal(sweepVerdict(null).state, 'unknown');
  assert.equal(sweepVerdict({ id: 1, status: 'running' }).state, 'unknown');
});

// ── buildDigest — the ✅ Healthy line ────────────────────────────────────────

test('(#485) ✅ Healthy still appears when everything really is healthy', () => {
  // The control for every assertion below: without it they all pass against a digest that has
  // simply stopped saying Healthy at all, which would be a different broken instrument.
  assert.match(buildDigest(CLEAN), /✅ \*\*Healthy/);
});

test('(#485) NO ✅ Healthy while the weekly sweep on main is failing', () => {
  const body = buildDigest({ ...CLEAN, sweep: { state: 'failure', text: 'run 3521 (2026-09-18T07:02:22Z) is FAILURE' } });
  assert.doesNotMatch(body, /✅ \*\*Healthy/, 'this is the 2026-09-18 11:57Z digest, verbatim');
  assert.match(body, /3521/, 'the digest must name the run so the operator can go and look');
});

test('(#485) NO ✅ Healthy while an UNKNOWN sweep verdict is all we have', () => {
  const body = buildDigest({ ...CLEAN, sweep: { state: 'unknown', text: 'no scheduled run found' } });
  assert.doesNotMatch(body, /✅ \*\*Healthy/, 'an unreadable sweep is the silence this digest exists to break');
});

test('(#485) NO ✅ Healthy while an open PR is blocked by a required context', () => {
  const body = buildDigest({
    ...CLEAN,
    blocked: [{ number: 478, title: 'chore(deps): pin dependencies', contexts: ['infra-image-scan / infra-image-scan'] }],
  });
  assert.doesNotMatch(body, /✅ \*\*Healthy/);
  assert.match(body, /#478/, 'the blocked PR must be named');
  assert.match(body, /infra-image-scan/, 'the blocking context must be named');
});

test('(#485) NO ✅ Healthy when branch protection could not be read at all', () => {
  // A missing scope must not present as "nothing is blocked" — that is the same class of fault as
  // the sweep being invisible, one layer up.
  assert.doesNotMatch(buildDigest({ ...CLEAN, requiredGlobs: null }), /✅ \*\*Healthy/);
  assert.doesNotMatch(buildDigest({ ...CLEAN, requiredGlobs: [] }), /✅ \*\*Healthy/);
});

test('(#485) the stability-days table no longer reads as a verdict on mergeability', () => {
  const body = buildDigest({ ...CLEAN, rows: [{ number: 478, title: 'pin deps', created_at: '2026-09-18T07:02:16Z', stability: 'success' }] });
  assert.match(body, /ADVISORY/, 'the column that said `success` for an unmergeable PR must say what it is');
});
