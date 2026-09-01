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

import { shellCanRunScript } from './shell-probe.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ci-log-step.sh');

// The probe lives in ./shell-probe.mjs so other suites inherit it rather than re-deriving it —
// it was already re-derived wrongly once (see that file's header). Re-exported because the
// probe meta-tests below exercise it directly.
export { shellCanRunScript };

// The wrapper is bash (it needs `pipefail`, which POSIX sh lacks). CI runs node:22-bookworm, which
// has bash and can read the checkout, so nothing here skips in CI.
const bashProbe = shellCanRunScript('bash', SCRIPT);
const needsBash = { skip: bashProbe.usable ? false : bashProbe.reason };

function run(args, { runId = 'test-run', job = 'test-job' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ci-step-log-'));
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: runId, GITHUB_JOB: job },
  });
  const dir = join(root, runId, job);
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
  const a = run(['demo', 'bash', '-c', 'echo run-one'], { runId: 'run-1', job: 'j' });
  assert.match(readFileSync(join(a.dir, 'demo.log'), 'utf8'), /run-one/);
  assert.equal(a.dir.endsWith(join('run-1', 'j')), true, 'log directory is not scoped by run id');
});

test('(f) bad usage exits 2 rather than silently doing nothing', needsBash, () => {
  assert.equal(run(['only-a-name']).code, 2);
});

test('(g) a failing wrapped step records its name so the digest can report it', needsBash, () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-step-log-'));
  const env = { ...process.env, CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: 'run-x', GITHUB_JOB: 'j' };
  spawnSync('bash', [SCRIPT, 'agent-gates-lint', 'bash', '-c', 'exit 1'], { encoding: 'utf8', env });
  const marker = join(root, 'run-x', 'j', '_failed-step');
  assert.ok(existsSync(marker), 'no _failed-step marker was written');
  assert.equal(readFileSync(marker, 'utf8').trim(), 'agent-gates-lint');
});

test('(g2) a PASSING step records no marker', needsBash, () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-step-log-'));
  const env = { ...process.env, CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: 'run-y', GITHUB_JOB: 'j' };
  spawnSync('bash', [SCRIPT, 'ok', 'bash', '-c', 'exit 0'], { encoding: 'utf8', env });
  assert.equal(existsSync(join(root, 'run-y', 'j', '_failed-step')), false, 'a passing step wrote a marker');
});

test('(g3) the FIRST failing step wins — a later wrapped step does not overwrite it', needsBash, () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-step-log-'));
  const env = { ...process.env, CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: 'run-z', GITHUB_JOB: 'j' };
  spawnSync('bash', [SCRIPT, 'first-fail', 'bash', '-c', 'exit 1'], { encoding: 'utf8', env });
  spawnSync('bash', [SCRIPT, 'second-fail', 'bash', '-c', 'exit 1'], { encoding: 'utf8', env });
  assert.equal(readFileSync(join(root, 'run-z', 'j', '_failed-step'), 'utf8').trim(), 'first-fail');
});

// --- (g4) TWO JOBS, ONE RUN — item #180 ---------------------------------------------------------
//
// `app-e2e` and `dast` are two jobs of the same run on the same self-hosted runner, sharing $HOME.
// Run-scoped, they shared ONE `_failed-step` file: whichever failed first wrote it and the other
// published it as its own failing step. MEASURED on app-ci run #1683 — the `app-e2e` digest
// reported `dast-install-latest-docker`, a step in the dast job.
//
// It was harmless that once only because both jobs died of the same upstream cause. The normal case
// is two jobs failing for different reasons, and then the digest sends its reader to the wrong job
// with full confidence and no way to tell from the digest that it happened.
test('(g4) two jobs failing in ONE run each record their OWN failing step', needsBash, () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-step-log-'));
  const inJob = (job) => ({ ...process.env, CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: 'run-shared', GITHUB_JOB: job });
  spawnSync('bash', [SCRIPT, 'dast-install-latest-docker', 'bash', '-c', 'exit 1'], { encoding: 'utf8', env: inJob('dast') });
  spawnSync('bash', [SCRIPT, 'web-e2e', 'bash', '-c', 'exit 1'], { encoding: 'utf8', env: inJob('app-e2e') });

  const marker = (job) => readFileSync(join(root, 'run-shared', job, '_failed-step'), 'utf8').trim();
  assert.equal(marker('dast'), 'dast-install-latest-docker');
  assert.equal(
    marker('app-e2e'),
    'web-e2e',
    'app-e2e adopted the sibling job\'s failing step — the marker is not job-scoped',
  );
});

// --- (g5) one job's step LOGS must not appear in another job's evidence -------------------------
//
// The same sharing put each job's `*.log` into the other's digest as `step:` excerpts, because the
// collector globs every .log in the directory. Item #180 scoped that out of its own criteria on the
// belief the step logs were "already correct"; they were not, and scoping the whole directory fixes
// both for the price of one.
test('(g5) two jobs in ONE run do not see each other\'s step logs', needsBash, () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-step-log-'));
  const inJob = (job) => ({ ...process.env, CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: 'run-shared2', GITHUB_JOB: job });
  spawnSync('bash', [SCRIPT, 'dast-zap', 'bash', '-c', 'echo zap'], { encoding: 'utf8', env: inJob('dast') });
  spawnSync('bash', [SCRIPT, 'web-e2e', 'bash', '-c', 'echo playwright'], { encoding: 'utf8', env: inJob('app-e2e') });

  assert.deepEqual(readdirSync(join(root, 'run-shared2', 'app-e2e')), ['web-e2e.log']);
  assert.deepEqual(readdirSync(join(root, 'run-shared2', 'dast')), ['dast-zap.log']);
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

// ⚠️ THE META-TESTS BELOW ASSERT PROPERTIES OF THE HOST, NOT OF THE CODE — so they must gate on the
// host exactly as the suite does. MEASURED ON WINDOWS 2026-08-10: `(probe1)` and `(probe4)` asserted
// unconditionally that this machine has a usable bash, and failed on a machine that does not. That is
// the Linux-assuming shape US5 exists to remove, introduced BY US5, in the very tests that prove the
// probe works. Left unfixed it would be the third instance of this feature committing its own defect.
const needsUsableBash = {
  skip: bashProbe.usable ? false : `no usable bash on this host — ${bashProbe.reason}`,
};

// `(probe2)`/`(probe3)` additionally need to EXECUTE a generated `#!` script. Windows cannot, so they
// gate on that capability separately rather than on bash alone — the two are not the same question,
// which is the whole lesson of the probe they are testing.
const canExecGeneratedScript = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'exec-probe-'));
    const sh = join(dir, 'probe-exec');
    writeFileSync(sh, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(sh, 0o755);
    return spawnSync(sh, [], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
})();
const needsExecutableScripts = {
  skip: canExecGeneratedScript
    ? false
    : 'this host cannot execute a generated `#!` script (Windows), so the detached-shell simulation cannot be built here',
};

/** A shell that STARTS but is in a different filesystem namespace — the WSL-shim condition. */
function fakeDetachedShell() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-shell-'));
  const sh = join(dir, 'detached-sh');
  writeFileSync(sh, '#!/usr/bin/env bash\n# Succeeds at starting; cannot see the real filesystem.\n'
    + 'case "$2" in\n  "exit 0") exit 0 ;;\n  *) exit 127 ;;\nesac\n');
  chmodSync(sh, 0o755);
  return sh;
}

test('(probe1) a real bash that CAN read the script is reported usable', needsUsableBash, () => {
  const v = shellCanRunScript('bash', SCRIPT);
  assert.equal(v.usable, true, `bash was rejected on a host that has it: ${v.reason}`);
  assert.equal(v.reason, null);
});

test('(probe2) a shell that starts but cannot reach the script is reported UNUSABLE, with a reason', needsExecutableScripts, () => {
  const v = shellCanRunScript(fakeDetachedShell(), SCRIPT);
  assert.equal(v.usable, false, 'a shell that cannot see the script under test was reported usable');
  assert.ok(v.reason, 'an unusable shell must skip WITH a reason — a reasonless skip is a false green');
  assert.match(v.reason, /cannot read|cannot reach/i, `the reason does not name the unmet condition: ${v.reason}`);
});

test('(probe3) the OLD probe would have passed that same shell — this is why it changed', needsExecutableScripts, () => {
  // Pins the defect itself, so the probe cannot quietly regress to asking the easier question.
  const sh = fakeDetachedShell();
  assert.equal(spawnSync(sh, ['-c', 'exit 0']).status, 0, 'the simulation is wrong — it must START cleanly');
  assert.equal(shellCanRunScript(sh, SCRIPT).usable, false);
});

test('(probe4) on THIS host the suite does not skip — a skip here would be a false pass', needsUsableBash, () => {
  // Linux dev container and the CI node:22-bookworm image both have a usable bash, so every case
  // above must actually execute. If this ever starts skipping, the skip count is the tell.
  assert.equal(needsBash.skip, false, `the ci-log-step suite skipped on a host with bash: ${needsBash.skip}`);
});

// ─── item #326 — a job killed at `timeout-minutes` publishes NO digest ───────────────────────────
//
// `always()` does not survive a job kill: when the runner enforces `timeout-minutes` the digest step
// never runs, so the ONE failure class with no other evidence trail (a hang) produces none. Measured
// on PR #322, app-e2e task 8317: 75.1 min against a 75 min ceiling and a ~29 min healthy baseline,
// and `ci-status failure` reported "no bundle exists … the job may have died before the digest step
// ran".
//
// The fix is to make the hang fail the STEP rather than the JOB, below the ceiling — so the job
// stays alive, the marker is written, and the digest runs and can name what was hanging.
function runWithTimeout(args, seconds, { runId = 'test-run', job = 'test-job' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ci-step-log-'));
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CI_STEP_LOG_ROOT: root,
      GITHUB_RUN_ID: runId,
      GITHUB_JOB: job,
      CI_STEP_TIMEOUT_SECONDS: String(seconds),
    },
  });
  const dir = join(root, runId, job);
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim() : null);
  return { code: r.status, dir, failedStep: read('_failed-step'), reason: read('_failed-step-reason') };
}

test('(#326a) a HANGING step is killed at its own timeout and reports a non-zero exit', needsBash, () => {
  const r = runWithTimeout(['hanging-step', 'sleep', '30'], 1);
  assert.notEqual(r.code, 0, 'a step that hung past its timeout reported success');
  assert.ok(r.code === 124 || r.code === 137, `expected a timeout exit (124/137), got ${r.code}`);
});

test('(#326b) the hung step is NAMED, so the digest does not say "_not reported_"', needsBash, () => {
  const r = runWithTimeout(['hanging-step', 'sleep', '30'], 1);
  assert.equal(r.failedStep, 'hanging-step');
});

test('(#326c) a TIMEOUT is distinguishable from an ordinary failure', needsBash, () => {
  // Criterion 2: the reader must not hunt for an assertion that never happened.
  const timedOut = runWithTimeout(['hanging-step', 'sleep', '30'], 1);
  assert.match(timedOut.reason ?? '', /timeout/i, 'a timeout was not recorded as such');
  assert.match(timedOut.reason ?? '', /after 1s\b/, 'the reason does not name the limit that was hit');

  const ordinary = runWithTimeout(['failing-step', 'false'], 30);
  assert.equal(ordinary.failedStep, 'failing-step');
  assert.equal(ordinary.reason, null, 'an ordinary failure was mislabelled as a timeout');
});

test('(#326d) an unset CI_STEP_TIMEOUT_SECONDS leaves behaviour exactly as before', needsBash, () => {
  const ok = run(['plain-step', 'echo', 'hello']);
  assert.equal(ok.code, 0);
  const bad = run(['plain-step', 'false']);
  assert.notEqual(bad.code, 0, 'pipefail semantics regressed');
});

test('(#326e) a step that finishes INSIDE its timeout is untouched', needsBash, () => {
  const r = runWithTimeout(['quick-step', 'echo', 'done'], 30);
  assert.equal(r.code, 0);
  assert.equal(r.failedStep, null);
  assert.equal(r.reason, null);
});

// The per-step ceiling is only useful while it stays BELOW the job ceiling. Raising it past the job
// timeout would restore the exact defect (a hung step killing the job before the digest step runs)
// while looking like the fix is still in place — so the arithmetic is pinned, not left to review.
const APP_CI = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.forgejo', 'workflows', 'app-ci.yml');

test('(#326j) app-e2e sets a per-step ceiling, and it is comfortably below the job ceiling', () => {
  const yaml = readFileSync(APP_CI, 'utf8');
  const step = yaml.match(/CI_STEP_TIMEOUT_SECONDS:\s*'?(\d+)'?/);
  assert.ok(step, 'app-e2e no longer sets CI_STEP_TIMEOUT_SECONDS — a hang would kill the job again');
  const stepSeconds = Number(step[1]);

  // The app-e2e job ceiling: the `timeout-minutes` nearest above the app-e2e job declaration.
  const jobIdx = yaml.indexOf('\n  app-e2e:');
  assert.ok(jobIdx > 0, 'app-e2e job not found — this guard is reading the wrong file');
  const jobCeiling = yaml.slice(jobIdx).match(/timeout-minutes:\s*(\d+)/);
  assert.ok(jobCeiling, 'app-e2e has no timeout-minutes');
  const jobSeconds = Number(jobCeiling[1]) * 60;

  assert.ok(stepSeconds < jobSeconds,
    `the step ceiling (${stepSeconds}s) is not below the job ceiling (${jobSeconds}s)`);
  // Room for the preceding bring-up, teardown, and the digest step itself.
  assert.ok(jobSeconds - stepSeconds >= 15 * 60,
    `only ${(jobSeconds - stepSeconds) / 60} min separates the two ceilings — a hung step would ` +
    'still reach the job ceiling before the digest could publish');
});
