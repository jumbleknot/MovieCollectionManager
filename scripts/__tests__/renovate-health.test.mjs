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
  const md = buildDigest({
    problems: [],
    branches: { emptyPr: [], stale: [], active: ['renovate/nx-monorepo'], unknown: [] },
    budgetInfo: { limit: 5, open: 1, headroom: 4 },
    rows: [{ number: 1, title: 't', stability: 'success', created_at: '2026-08-28T00:00:00Z' }],
  });
  assert.match(md, /✅/);
  assert.doesNotMatch(md, /⚠️|❌/);
});

test('every anomaly class is surfaced, with the runbook action it maps to', () => {
  const md = buildDigest({
    problems: ['⚠️ WARN: execa promise rejection suppressed'],
    branches: { emptyPr: ['renovate/a'], stale: ['renovate/b'], active: [], unknown: ['renovate/c'] },
    budgetInfo: { limit: 5, open: 5, headroom: 0 },
    rows: [{ number: 7, title: 'x', stability: 'pending', created_at: '2026-08-01T00:00:00Z' }],
  });
  assert.match(md, /execa promise rejection suppressed/); // dead channel — §5
  assert.match(md, /renovate\/a/); // empty PR — §2
  assert.match(md, /renovate\/b/); // stale ref — §2
  assert.match(md, /renovate\/c/); // unknown ancestry — never silently dropped
  assert.match(md, /headroom.*0|0.*headroom/i); // budget exhausted — §1
  assert.match(md, /stability-days/);
});
