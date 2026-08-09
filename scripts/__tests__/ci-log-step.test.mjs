// Guards scripts/ci-log-step.sh (feature 042, T041).
//
// The exit-code case is the one that matters. `cmd | tee` returns TEE's status, so a wrapper
// without `set -o pipefail` turns every FAILING step into a passing one — CI goes silently green.
// That is strictly worse than the missing-logs problem the wrapper exists to solve, so it is pinned
// here rather than left to review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ci-log-step.sh');

/**
 * Can this shell actually RUN the script under test?
 *
 * The previous probe asked `bash -c 'exit 0'` — "does a shell called bash start?". That is not the
 * question. On the operator's Windows host `bash` on PATH is the WSL shim: it starts perfectly, and
 * then cannot see `E:\…` at all. The probe said "usable" and all nine cases failed with status 127,
 * nine red tests that say nothing about the code. (Git Bash is installed there and would work; it is
 * simply not what is on PATH.)
 *
 * So ask the CANDIDATE SHELL whether it can read the script — the capability actually required. Both
 * wrong answers are costly: a false "usable" gives meaningless failures, and a false "unusable"
 * gives a silent skip, which is the false green this feature exists to remove. Hence the skip always
 * carries a reason NAMING the unmet condition.
 */
export function shellCanRunScript(shell, script) {
  const r = spawnSync(shell, ['-c', `test -r "${script}"`], { encoding: 'utf8' });
  if (r.error) {
    return { usable: false, reason: `\`${shell}\` could not be started (${r.error.code ?? r.error.message})` };
  }
  if (r.status !== 0) {
    return {
      usable: false,
      reason:
        `\`${shell}\` starts but cannot read ${script} — it is a shell from a different filesystem `
        + 'namespace (typically the WSL bash on PATH for a Windows checkout). Put a shell that can '
        + 'see this working tree on PATH, e.g. Git Bash, and re-run.',
    };
  }
  return { usable: true, reason: null };
}

// The wrapper is bash (it needs `pipefail`, which POSIX sh lacks). CI runs node:22-bookworm, which
// has bash and can read the checkout, so nothing here skips in CI.
const bashProbe = shellCanRunScript('bash', SCRIPT);
const needsBash = { skip: bashProbe.usable ? false : bashProbe.reason };

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

test('(g) a failing wrapped step records its name so the digest can report it', needsBash, () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-step-log-'));
  const env = { ...process.env, CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: 'run-x' };
  spawnSync('bash', [SCRIPT, 'agent-gates-lint', 'bash', '-c', 'exit 1'], { encoding: 'utf8', env });
  const marker = join(root, 'run-x', '_failed-step');
  assert.ok(existsSync(marker), 'no _failed-step marker was written');
  assert.equal(readFileSync(marker, 'utf8').trim(), 'agent-gates-lint');
});

test('(g2) a PASSING step records no marker', needsBash, () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-step-log-'));
  const env = { ...process.env, CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: 'run-y' };
  spawnSync('bash', [SCRIPT, 'ok', 'bash', '-c', 'exit 0'], { encoding: 'utf8', env });
  assert.equal(existsSync(join(root, 'run-y', '_failed-step')), false, 'a passing step wrote a marker');
});

test('(g3) the FIRST failing step wins — a later wrapped step does not overwrite it', needsBash, () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-step-log-'));
  const env = { ...process.env, CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: 'run-z' };
  spawnSync('bash', [SCRIPT, 'first-fail', 'bash', '-c', 'exit 1'], { encoding: 'utf8', env });
  spawnSync('bash', [SCRIPT, 'second-fail', 'bash', '-c', 'exit 1'], { encoding: 'utf8', env });
  assert.equal(readFileSync(join(root, 'run-z', '_failed-step'), 'utf8').trim(), 'first-fail');
});

// --- (probe) the capability probe must answer the question being ASKED (feature 051 US5) ---------
//
// The old probe was `spawnSync('bash', ['-c', 'exit 0']).status === 0` — "does a shell called bash
// start?". On the operator's Windows host it does: `bash` on PATH is the WSL shim, which starts
// perfectly and then cannot see `E:\…` at all. So the probe reported the shell as usable and all
// nine cases failed with status 127 — nine red tests that say nothing about the code under test.
// (Git Bash is installed on that host and would work; it is simply not what is on PATH.)
//
// This is the same shape as CLAUDE.md's gate on proving "it can't run in this environment": the
// probe answered *does a shell exist* when the question is *can that shell reach my files*. A wrong
// answer in either direction is bad — a false "usable" gives nine meaningless failures, a false
// "unusable" gives a silent skip, which is the false green this whole feature exists to remove.

/** A shell that STARTS but is in a different filesystem namespace — the WSL-shim condition. */
function fakeDetachedShell() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-shell-'));
  const sh = join(dir, 'detached-sh');
  writeFileSync(sh, '#!/usr/bin/env bash\n# Succeeds at starting; cannot see the real filesystem.\n'
    + 'case "$2" in\n  "exit 0") exit 0 ;;\n  *) exit 127 ;;\nesac\n');
  chmodSync(sh, 0o755);
  return sh;
}

test('(probe1) a real bash that CAN read the script is reported usable', () => {
  const v = shellCanRunScript('bash', SCRIPT);
  assert.equal(v.usable, true, `bash was rejected on a host that has it: ${v.reason}`);
  assert.equal(v.reason, null);
});

test('(probe2) a shell that starts but cannot reach the script is reported UNUSABLE, with a reason', () => {
  const v = shellCanRunScript(fakeDetachedShell(), SCRIPT);
  assert.equal(v.usable, false, 'a shell that cannot see the script under test was reported usable');
  assert.ok(v.reason, 'an unusable shell must skip WITH a reason — a reasonless skip is a false green');
  assert.match(v.reason, /cannot read|cannot reach/i, `the reason does not name the unmet condition: ${v.reason}`);
});

test('(probe3) the OLD probe would have passed that same shell — this is why it changed', () => {
  // Pins the defect itself, so the probe cannot quietly regress to asking the easier question.
  const sh = fakeDetachedShell();
  assert.equal(spawnSync(sh, ['-c', 'exit 0']).status, 0, 'the simulation is wrong — it must START cleanly');
  assert.equal(shellCanRunScript(sh, SCRIPT).usable, false);
});

test('(probe4) on THIS host the suite does not skip — a skip here would be a false pass', () => {
  // Linux dev container and the CI node:22-bookworm image both have a usable bash, so every case
  // above must actually execute. If this ever starts skipping, the skip count is the tell.
  assert.equal(needsBash.skip, false, `the ci-log-step suite skipped on a host with bash: ${needsBash.skip}`);
});
