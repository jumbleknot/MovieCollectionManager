// Guards scripts/ci-log-step.sh (feature 042, T041).
//
// The exit-code case is the one that matters. `cmd | tee` returns TEE's status, so a wrapper
// without `set -o pipefail` turns every FAILING step into a passing one — CI goes silently green.
// That is strictly worse than the missing-logs problem the wrapper exists to solve, so it is pinned
// here rather than left to review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ci-log-step.sh');

// The wrapper is bash (it needs `pipefail`, which POSIX sh lacks). CI runs node:22-bookworm, which
// has bash; a bare alpine image does not. Skip cleanly there rather than reporting seven failures
// that say nothing about the code.
const HAS_BASH = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const needsBash = { skip: HAS_BASH ? false : 'bash unavailable in this image (CI runs node:22-bookworm, which has it)' };

function run(args, { runId = 'test-run' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ci-step-log-'));
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: runId },
  });
  const dir = join(root, runId);
  const logs = existsSync(dir) ? readdirSync(dir) : [];
  return { code: r.status, stdout: r.stdout ?? '', root, dir, logs };
}

test('(a) a FAILING command still exits non-zero — tee must not mask it', needsBash, () => {
  // Without `set -o pipefail` this returns 0 and a broken build reports green.
  const r = run(['demo', 'bash', '-c', 'echo working; exit 7']);
  assert.notEqual(r.code, 0, 'a failing command exited 0 — tee masked the failure');
  assert.equal(r.code, 7, `expected the command's own exit code, got ${r.code}`);
});

test('(a2) a passing command exits 0', needsBash, () => {
  assert.equal(run(['demo', 'bash', '-c', 'echo fine']).code, 0);
});

test('(b) the output is mirrored to the log AND still reaches stdout', needsBash, () => {
  // Mirrored, not diverted: the run log a human reads in the web UI must be unchanged.
  const r = run(['demo', 'bash', '-c', 'echo hello-from-step']);
  assert.match(r.stdout, /hello-from-step/, 'output no longer reaches the job log');
  assert.deepEqual(r.logs, ['demo.log']);
  assert.match(readFileSync(join(r.dir, 'demo.log'), 'utf8'), /hello-from-step/);
});

test('(c) STDERR is captured too — that is where stack traces live', needsBash, () => {
  const r = run(['demo', 'bash', '-c', 'echo to-stderr >&2; exit 1']);
  assert.equal(r.code, 1);
  assert.match(readFileSync(join(r.dir, 'demo.log'), 'utf8'), /to-stderr/);
});

test('(d) output of a FAILING command is captured before the failure propagates', needsBash, () => {
  // The whole point: the digest needs what the step printed on its way down.
  const r = run(['demo', 'bash', '-c', 'echo FAILED tests/e2e/foo.spec.ts; echo "  expected 5, got 4" >&2; exit 1']);
  assert.equal(r.code, 1);
  const log = readFileSync(join(r.dir, 'demo.log'), 'utf8');
  assert.match(log, /FAILED tests\/e2e\/foo\.spec\.ts/);
  assert.match(log, /expected 5, got 4/);
});

test('(e) logs are scoped per run — a persistent runner cannot leak a previous run in', needsBash, () => {
  // This runner IS persistent, so an unscoped directory would put a stale run's output into
  // today's digest and send the reader after a failure that already got fixed.
  const a = run(['demo', 'bash', '-c', 'echo run-one'], { runId: 'run-1' });
  assert.match(readFileSync(join(a.dir, 'demo.log'), 'utf8'), /run-one/);
  assert.equal(a.dir.endsWith('run-1'), true, 'log directory is not scoped by run id');
});

test('(f) bad usage exits 2 rather than silently doing nothing', needsBash, () => {
  assert.equal(run(['only-a-name']).code, 2);
});
