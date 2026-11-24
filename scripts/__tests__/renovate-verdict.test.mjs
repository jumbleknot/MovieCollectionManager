// Items #1125, #1124, #1123 — scripts/renovate-verdict.mjs, offline.
//
// The fixtures mirror Renovate 44's JSON log records as written to RENOVATE_LOG_FILE: bunyan `level`,
// `msg`, `time`, with `Repository finished` carrying `result`/`status` at the top level and
// `branches info extended` carrying `branchesInformation[]` (branchName, result, upgrades[].updateType).
// The record shapes were read from renovate@44.260.2's dist and a local run's log (2026-11-24).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judgeRun,
  parseLog,
  lockFileState,
  digestStaleness,
  preflight,
  resolveCommand,
  DEAD_STATES,
} from '../renovate-verdict.mjs';
import { parseWindow, inWindow } from '../lib/renovate-window.mjs';
import { ArgvError } from '../lib/argv-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = JSON.parse(readFileSync(resolve(ROOT, 'renovate.json'), 'utf8'));
const WINDOW = parseWindow(CONFIG);
// Friday 2026-11-20 07:00 UTC = 02:00 EST — inside `* 2-4 * * 5` America/New_York. Thursday 03:00 UTC is not.
const IN = '2026-11-20T07:00:05.000Z';
const OUT = '2026-11-19T03:00:05.000Z';

const start = (time) => ({ level: 30, msg: 'Repository started', time });
const finished = (over = {}) => ({ level: 30, msg: 'Repository finished', result: 'done', status: 'activated', durationMs: 600000, time: '2026-11-20T07:10:00.000Z', ...over });
const branch = (branchName, result, updateType = 'minor') => ({ branchName, result, upgrades: [{ depName: 'x', updateType }] });
const info = (...branches) => ({ level: 20, msg: 'branches info extended', branchesInformation: branches, time: '2026-11-20T07:09:00.000Z' });
const LFM = (result, name = 'renovate/lock-file-maintenance') => branch(name, result, 'lockFileMaintenance');

const judge = (entries, { dryRun = false } = {}) => judgeRun(entries, { window: WINDOW, dryRun });

test('the window fixtures really are inside and outside the window renovate.json declares', () => {
  assert.equal(inWindow(IN, WINDOW), true);
  assert.equal(inWindow(OUT, WINDOW), false);
});

test('a live in-window run that refreshed the lock files passes', () => {
  const r = judge([start(IN), info(branch('renovate/a', 'pr-created'), LFM('pr-created')), finished()]);
  assert.deepEqual(r.failures, []);
  assert.equal(r.lockFile.state, 'refreshed');
  assert.equal(r.inWindow, true);
});

test('"nothing to refresh" is a pass, and is reported as such — not as dead', () => {
  const r = judge([start(IN), info(LFM('no-work')), finished()]);
  assert.deepEqual(r.failures, []);
  assert.equal(r.lockFile.state, 'nothing');
  assert.ok(!DEAD_STATES.has('nothing'));
});

for (const [result, state, why] of [
  ['not-scheduled', 'not-scheduled', /no longer intersect/],
  ['pr-limit-reached', 'starved', /limit was spent/],
  ['branch-limit-reached', 'starved', /limit was spent/],
  ['commit-hourly-limit-reached', 'starved', /limit was spent/],
  ['already-existed', 'rejected', /closed/],
  ['error', 'error', /errored/],
]) {
  test(`in the window, a lock-file branch that is ${result} FAILS the run (${state})`, () => {
    const r = judge([start(IN), info(LFM(result)), finished()]);
    assert.equal(r.lockFile.state, state);
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], new RegExp(`lock-file channel is ${state.toUpperCase()}`));
    assert.match(r.failures[0], why);
  });
}

test('in the window, NO lockFileMaintenance branch at all fails as ABSENT (a dead channel, #218)', () => {
  const r = judge([start(IN), info(branch('renovate/a', 'pr-created')), finished()]);
  assert.equal(r.lockFile.state, 'absent');
  assert.match(r.failures.join('\n'), /lock-file channel is ABSENT/);
});

test('the WORST lock-file branch decides: one starved ecosystem is a dead channel even if another refreshed', () => {
  const r = judge([start(IN), info(LFM('pr-created'), LFM('pr-limit-reached', 'renovate/lock-file-maintenance-python-deps')), finished()]);
  assert.equal(r.lockFile.state, 'starved');
  assert.equal(r.failures.length, 1);
});

test('OUTSIDE the window a not-scheduled lock-file branch is expected, and reported without failing', () => {
  const r = judge([start(OUT), info(LFM('not-scheduled')), finished()]);
  assert.deepEqual(r.failures, []);
  assert.equal(r.inWindow, false);
  assert.match(r.report.join('\n'), /lock-file maintenance: not-scheduled/);
});

test('a DRY RUN never fails on the lock-file channel — it creates nothing by design', () => {
  const r = judge([start(IN), info(LFM('pr-limit-reached')), finished()], { dryRun: true });
  assert.deepEqual(r.failures, []);
  assert.match(r.report.join('\n'), /DRY RUN/);
});

test('a run with no "Repository finished" fails — the repository was not processed to completion', () => {
  const r = judge([start(IN), info(LFM('pr-created'))]);
  assert.match(r.failures.join('\n'), /found 0/);
});

test('a repository result other than "done" fails, naming it', () => {
  const r = judge([start(OUT), finished({ result: 'external-host-error', status: 'unknown' })]);
  assert.match(r.failures.join('\n'), /result is "external-host-error"/);
});

test('an ERROR entry fails the run even though Renovate finished "done"', () => {
  const r = judge([start(OUT), { level: 50, msg: 'Error updating branch', time: OUT }, finished()]);
  assert.match(r.failures.join('\n'), /1 ERROR\/FATAL log entry: "Error updating branch"/);
});

test('WARN entries do not fail the run — Renovate warns routinely (rate limits, lookups)', () => {
  const r = judge([start(OUT), { level: 40, msg: 'Rate limit exceeded for api.github.com', time: OUT }, finished()]);
  assert.deepEqual(r.failures, []);
});

test('an EMPTY log fails — a run that wrote nothing cannot be verified', () => {
  assert.match(judge([]).failures[0], /EMPTY/);
});

test('in the window without branch information, the channel is unverifiable and the run fails', () => {
  const r = judge([start(IN), finished()]);
  assert.match(r.failures.join('\n'), /cannot be verified/);
});

test('parseLog skips non-JSON lines and counts them, rather than dying on interleaved text', () => {
  const { entries, unparseable } = parseLog(`${JSON.stringify(start(IN))}\nnot json\n\n${JSON.stringify(finished())}\n`);
  assert.equal(entries.length, 2);
  assert.equal(unparseable, 1);
});

test('lockFileState covers every BranchResult Renovate 44 defines', () => {
  const all = ['already-existed', 'automerged', 'done', 'error', 'needs-approval', 'needs-pr-approval', 'not-scheduled', 'no-work', 'pending', 'pr-created', 'pr-edited', 'pr-limit-reached', 'commit-per-run-limit-reached', 'commit-hourly-limit-reached', 'branch-limit-reached', 'rebase', 'update-not-scheduled', 'minimum-group-size-not-met'];
  const other = all.filter((r) => lockFileState(r) === 'other');
  assert.deepEqual(other, ['needs-approval', 'needs-pr-approval', 'minimum-group-size-not-met'], 'a result fell through to "other" unintentionally');
});

// ── Item #1123: the health digest's silence ──────────────────────────────────────────────────────

const NOW = new Date('2026-11-24T03:05:00Z');
test('a digest from the last 8 days is fresh', () => {
  assert.equal(digestStaleness({ state: 'open' }, [{ created_at: '2026-11-20T11:00:30Z' }], NOW), null);
});
test('a digest older than 8 days is STALE, and the failure names its age', () => {
  assert.match(digestStaleness({ state: 'open' }, [{ created_at: '2026-11-13T11:00:30Z' }], NOW), /10\.7 days old \(limit 8\)/);
});
test('no digest at all in the window read is stale too — absence must not read as health', () => {
  assert.match(digestStaleness({ state: 'open' }, [], NOW), /no health digest from the last 8 days/);
});
test('a CLOSED item #311 expects no digest — closing it is the kill switch', () => {
  assert.equal(digestStaleness({ state: 'closed' }, [], NOW), null);
});

// ── Item #1125: the token preflight ──────────────────────────────────────────────────────────────

test('preflight names the missing scope for each 403, and the bad token for a 401', async () => {
  const answers = { '/user': 401, '/repos/o/r': 200 };
  const get = async (path) => ({ status: answers[path] ?? (path.includes('/issues') ? 403 : 200) });
  const problems = await preflight(get, 'o/r');
  assert.equal(problems.length, 2);
  assert.match(problems[0], /\/user → 401: RENOVATE_TOKEN is missing, expired or wrong/);
  assert.match(problems[1], /issues.* → 403: RENOVATE_TOKEN lacks the read:issue scope/);
});

test('preflight passes when every probe answers 200', async () => {
  assert.deepEqual(await preflight(async () => ({ status: 200 }), 'o/r'), []);
});

test('preflight reports an unreachable forge instead of throwing', async () => {
  const problems = await preflight(async () => { throw new Error('ECONNREFUSED'); }, 'o/r');
  assert.equal(problems.length, 4);
  assert.match(problems[0], /did not answer \(ECONNREFUSED\)/);
});

// ── The argument contract ────────────────────────────────────────────────────────────────────────

test('argv: preflight | verdict --log <file>; anything else is a usage error', () => {
  assert.deepEqual(resolveCommand(['preflight']), { command: 'preflight' });
  assert.deepEqual(resolveCommand(['verdict', '--log', 'x.ndjson']), { command: 'verdict', log: 'x.ndjson' });
  assert.equal(resolveCommand(['--help', 'verdict']).command, 'help');
  assert.throws(() => resolveCommand([]), ArgvError);
  assert.throws(() => resolveCommand(['verdict']), ArgvError);
  assert.throws(() => resolveCommand(['preflight', '--log', 'x']), ArgvError);
  assert.throws(() => resolveCommand(['verdikt', '--log', 'x']), ArgvError);
  assert.throws(() => resolveCommand(['verdict', '--logs', 'x']), ArgvError);
});
