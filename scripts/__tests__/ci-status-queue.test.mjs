// `ci-status.mjs queue` (item #925): how long each job waited for the runner. The forge stamps a task
// only when a runner picks it up (task created_at == run_started_at), so the wait is DERIVED:
// runnable = max(run created, finish of each `needs` job), wait = pickup − runnable. These pin that
// derivation offline. The fixture is the measured 2026-11-25 case: main's trigger-cd for 8ae7f9d0
// (run 8312) waited behind PR run 8316's dast and app-e2e.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQueueWaits, summarizeQueue, renderQueue, parseTargetArgs, fmtWait } from '../ci-status.mjs';

const T = (id, name, run, created, updated, extra = {}) => ({
  id, name, run_number: run, workflow_id: 'app-ci.yml', event: 'push', status: 'success',
  created_at: created, updated_at: updated, head_sha: 'a'.repeat(40), ...extra,
});
const NEEDS = {
  'app-image-scan': ['changes', 'app-e2e'],
  'trigger-cd': ['affected', 'mc-service-checks', 'mc-service-checks-integration', 'app-e2e', 'dast', 'app-image-scan'],
};
const needsOf = (_wf, job) => NEEDS[job] ?? [];

// Run 8312 (main push): the parts of it that matter, as the forge reported them.
const RUN_8312 = [
  T(29200, 'changes', 8312, '2026-11-25T19:20:00Z', '2026-11-25T19:20:10Z'),
  T(29201, 'affected', 8312, '2026-11-25T19:20:11Z', '2026-11-25T19:21:00Z'),
  T(29202, 'mc-service-checks', 8312, '2026-11-25T19:21:01Z', '2026-11-25T19:25:00Z'),
  T(29203, 'mc-service-checks-integration', 8312, '2026-11-25T19:25:00Z', '2026-11-25T19:25:00Z', { status: 'skipped' }),
  T(29204, 'dast', 8312, '2026-11-25T19:25:01Z', '2026-11-25T19:35:00Z'),
  T(29205, 'app-e2e', 8312, '2026-11-25T19:35:01Z', '2026-11-25T19:42:43Z'),
  T(29254, 'app-image-scan', 8312, '2026-11-25T19:51:48Z', '2026-11-25T19:51:58Z'),
  T(29260, 'trigger-cd', 8312, '2026-11-25T20:33:22Z', '2026-11-25T20:33:30Z'),
];
const RUNS = new Map([[8312, { created: '2026-11-25T19:19:55Z' }]]);

test('trigger-cd waits from the finish of its LAST need, not from its run: the measured 41m24s', () => {
  const rows = computeQueueWaits(RUN_8312, RUNS, needsOf);
  const cd = rows.find((r) => r.job === 'trigger-cd');
  assert.equal(cd.readyAt, '2026-11-25T19:51:58Z', 'app-image-scan finished last');
  assert.equal(cd.waitSeconds, 41 * 60 + 24);
  assert.equal(fmtWait(cd.waitSeconds), '41m24s');
  // app-image-scan became runnable when app-e2e finished (19:42:43) and was picked up at 19:51:48.
  assert.equal(rows.find((r) => r.job === 'app-image-scan').waitSeconds, 9 * 60 + 5);
});

test('a job with no needs waits from its run\'s creation', () => {
  const [changes] = computeQueueWaits(RUN_8312, RUNS, needsOf);
  assert.equal(changes.job, 'changes');
  assert.equal(changes.waitSeconds, 5);
  assert.equal(changes.why, 'after run created');
});

test('a skipped job is not a sample: the forge decides it without a runner', () => {
  assert.ok(!computeQueueWaits(RUN_8312, RUNS, needsOf).some((r) => r.job === 'mc-service-checks-integration'));
});

test('a skipped NEED still gates readiness at the time it was decided', () => {
  const rows = computeQueueWaits(
    [T(1, 'a', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z', { status: 'skipped' }), T(2, 'b', 1, '2026-01-01T00:15:00Z', '2026-01-01T00:16:00Z')],
    new Map([[1, { created: '2026-01-01T00:00:00Z' }]]),
    (_w, job) => (job === 'b' ? ['a'] : []),
  );
  assert.equal(rows.find((r) => r.job === 'b').waitSeconds, 300);
});

test('a re-run counts once, as its newest attempt, and its needs resolve to their newest attempts', () => {
  const tasks = [
    T(10, 'changes', 5, '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'),
    T(11, 'app-e2e', 5, '2026-01-01T00:01:00Z', '2026-01-01T00:30:00Z', { status: 'failure' }),
    T(20, 'app-e2e', 5, '2026-01-01T01:00:00Z', '2026-01-01T01:30:00Z'),
    T(21, 'app-image-scan', 5, '2026-01-01T01:40:00Z', '2026-01-01T01:41:00Z'),
  ];
  const rows = computeQueueWaits(tasks, new Map([[5, { created: '2026-01-01T00:00:00Z' }]]), needsOf);
  assert.deepEqual(rows.filter((r) => r.job === 'app-e2e').map((r) => r.task), [20]);
  assert.equal(rows.find((r) => r.job === 'app-image-scan').waitSeconds, 600, 'from the re-run\'s finish (01:30)');
});

test('an unknown run, an unreadable workflow or a need with no task is UNDETERMINED, never zero', () => {
  const t = [T(1, 'trigger-cd', 9, '2026-01-01T01:00:00Z', '2026-01-01T01:01:00Z')];
  assert.equal(computeQueueWaits(t, new Map(), needsOf)[0].why, 'run not in the sample');
  const runs = new Map([[9, { created: '2026-01-01T00:00:00Z' }]]);
  assert.equal(computeQueueWaits(t, runs, () => null)[0].why, 'workflow unreadable');
  const r = computeQueueWaits(t, runs, needsOf)[0];
  assert.equal(r.waitSeconds, null);
  assert.match(r.why, /needs affected, which has no task in the sample/);
  const s = summarizeQueue([r]);
  assert.equal(s.n, 0);
  assert.equal(s.undetermined, 1);
  assert.match(renderQueue(s, [r], { from: 'x', to: 'y' }), /Undetermined[\s\S]*task 1 app-ci \/ trigger-cd run 9/);
});

test('summary: per job and event, nearest-rank median and p90, worst task named', () => {
  const rows = [60, 120, 180, 240, 3600].map((w, i) => ({ task: i, workflow: 'app-ci', job: 'app-e2e', event: 'pull_request', run: i, pickedAt: `2026-01-01T00:0${i}:00Z`, waitSeconds: w }));
  rows.push({ task: 9, workflow: 'app-ci', job: 'trigger-cd', event: 'push', run: 9, pickedAt: '2026-01-01T01:00:00Z', waitSeconds: 30 });
  const s = summarizeQueue(rows);
  assert.equal(s.n, 6);
  const e2e = s.jobs.find((j) => j.key === 'app-ci / app-e2e (pull_request)');
  assert.deepEqual([e2e.n, e2e.median, e2e.p90, e2e.max, e2e.worst.task], [5, 180, 3600, 3600, 4]);
  assert.equal(s.jobs[0].key, 'app-ci / app-e2e (pull_request)', 'worst job first');
});

test('--from/--to must be ISO-8601 UTC; anything else is a usage error, not an empty window', () => {
  assert.deepEqual(parseTargetArgs(['queue', '--from', '2026-11-27T02:00:00Z', '--to', '2026-11-27T12:00Z']).target, { from: '2026-11-27T02:00:00Z', to: '2026-11-27T12:00Z' });
  for (const bad of ['2026-11-27', '2026-11-27T02:00:00+01:00', 'friday', '2026-13-40T99:00:00Z']) {
    assert.throws(() => parseTargetArgs(['queue', '--from', bad]), /ISO-8601 UTC/, bad);
  }
  assert.throws(() => parseTargetArgs(['queue', '--from']), /requires a value/);
});
