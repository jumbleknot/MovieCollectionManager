// Feature 052 US2 — the contention tally, and the two traps that would make it lie.
//
// The tally is the ONLY artifact of the measurement stage that a working session can read. The BFF
// container log is collected only under `failure()`, uploaded as an artifact the forge API cannot
// read, and fed to a tail-biased digest that keeps at most three sources — so a count that exists
// only in that log is not a result. `scripts/e2e-contention-tally.sh` lifts it into a `step:` source,
// which the digest ranks above every container log.
//
// Two traps are pinned here rather than trusted, because each produces a WRONG ANSWER rather than an
// obvious break:
//
//   1. `grep -c` exits 1 when it matches nothing, and `ci-log-step.sh` re-raises the wrapped exit
//      code by design (its `pipefail` is load-bearing). Naive counting therefore turns an all-zeros
//      measurement — the best possible news — into a red job.
//   2. `0` and `unavailable` must never be conflated. `0` means "measured, nothing happened";
//      `unavailable` means "not measured". SC-001 is satisfied only by the former, so rendering a
//      missing container as `0` would let a structural failure pass as a clean result.
//
// Contract: specs/052-e2e-worker-session-contention/contracts/contention-tally.md
//
// Deterministic, offline, token-free, node: built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { needsShell } from './shell-probe.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/e2e-contention-tally.sh');

// Gate every case on the host actually being able to RUN the script, not merely on `bash` existing.
// MEASURED ON WINDOWS 2026-08-10: all 11 cases here failed with `127 !== 0`, because `bash` on PATH
// was the WSL shim — it starts fine and cannot see `E:\…`. This is exactly the defect feature 051's
// US5 removed from ci-log-step.test.mjs, reintroduced by copying the older `spawnSync('bash', …)`
// shape. Eleven red tests that said nothing about the code under test.
const needsBash = needsShell('bash', SCRIPT);

// ⚠️ APPLIED ONLY TO THE CASES THAT ACTUALLY SPAWN A SHELL. The four workflow-wiring assertions
// below (`app-ci runs the tally through ci-log-step`, `… with --gate`, `… is always()`, `… runs
// AFTER the web E2E`) only `readFileSync(APP_CI)` and match YAML — no shell, no script. Gating them
// too was measured on Windows 2026-08-10 turning four PASSES into skips: honest skips, but broader
// than the condition requires, so four assertions silently lost their Windows coverage.
//
// That is the same defect as the one this probe exists to fix, in the opposite direction: a gate
// that does not match the capability actually needed. Under-skipping gives meaningless failures;
// OVER-skipping gives meaningless passes. Gate each case on what that case does.

const APP_CI = resolve(REPO_ROOT, '.forgejo/workflows/app-ci.yml');

/** One structured BFF audit line, as the logger actually writes it. */
function auditLine(action, extra = {}) {
  return JSON.stringify({
    time: '2026-08-09T12:00:00.000Z',
    level: 'info',
    service: 'mcm-bff',
    msg: `audit:${action}`,
    audit: true,
    action,
    ...extra,
  });
}

/**
 * Run the tally against a fixture log, bypassing Docker.
 *
 * The file seam is what makes this testable at all: a script that could only read a live container
 * could only be verified by running CI, which is the loop this feature exists to shorten.
 */
function runTally(logContents, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'contention-tally-'));
  try {
    const env = { ...process.env };
    if (logContents === null) {
      // No source at all — the container-absent case.
      env.E2E_CONTENTION_LOG_FILE = join(dir, 'does-not-exist.log');
      env.E2E_CONTENTION_CONTAINER = 'container-that-does-not-exist-052';
    } else {
      const file = join(dir, 'bff.log');
      writeFileSync(file, logContents);
      env.E2E_CONTENTION_LOG_FILE = file;
    }
    const res = spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The single `[e2e-contention]` counter line, which must be present exactly once. */
function tallyLine(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith('[e2e-contention] refresh_total='));
  assert.equal(lines.length, 1, `expected exactly one tally line, got ${lines.length}:\n${stdout}`);
  return lines[0];
}

test('counts each event and prints exactly one tally line in the contracted shape', needsBash, () => {
  const log = [
    auditLine('refresh_attempted'),
    auditLine('refresh_attempted'),
    auditLine('refresh_rate_limited'),
    auditLine('refresh_attempted'),
    auditLine('session_evicted'),
    auditLine('login'), // unrelated audit traffic must not be counted
    'not json at all',
  ].join('\n');

  const { status, stdout } = runTally(log);

  assert.equal(status, 0);
  assert.equal(
    tallyLine(stdout),
    '[e2e-contention] refresh_total=3 refresh_429=1 session_evicted=1',
  );
});

test('a zero count is reported as 0 and still exits 0 — the grep -c trap', needsBash, () => {
  // A log with plenty of traffic but none of the three events. Under naive `grep -c` this is the
  // case that exits 1, fails the ci-log-step wrapper, and reddens a job that had good news.
  const log = [auditLine('login'), auditLine('logout'), auditLine('auth_failed')].join('\n');

  const { status, stdout } = runTally(log);

  assert.equal(status, 0, 'an all-zeros tally must never fail the step');
  assert.equal(
    tallyLine(stdout),
    '[e2e-contention] refresh_total=0 refresh_429=0 session_evicted=0',
  );
});

test('an empty log is 0, not unavailable', needsBash, () => {
  const { status, stdout } = runTally('');

  assert.equal(status, 0);
  assert.equal(
    tallyLine(stdout),
    '[e2e-contention] refresh_total=0 refresh_429=0 session_evicted=0',
  );
});

test('a confident all-zero over real BFF traffic is flagged as a missing build, not a result', needsBash, () => {
  // The false zero the 0-vs-unavailable rule does NOT cover: a BFF running a build without feature
  // 052's instrumentation answers `0` for everything, cleanly and wrongly. refresh cadence is set by
  // the 5-minute access-token lifespan, so across a real run refresh_total=0 means the instrumented
  // image did not ship. Found by running the tally against the live dev container, which predated
  // the instrumentation and duly reported a tidy row of zeros.
  const log = [auditLine('login'), auditLine('logout')].join('\n');

  const { status, stdout } = runTally(log);

  assert.equal(status, 0);
  assert.equal(tallyLine(stdout), '[e2e-contention] refresh_total=0 refresh_429=0 session_evicted=0');
  assert.match(stdout, /\[e2e-contention\] caution: refresh_total=0 across 2 BFF log entries/);
});

test('no caution when there was no BFF traffic to draw the inference from', needsBash, () => {
  // An empty log is a legitimate 0 with nothing to conclude from. Warning here would train the
  // reader to ignore the caution line in the case where it matters.
  const { status, stdout } = runTally('');

  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /caution:/);
});

test('an unreadable source reports unavailable — never 0 — and still exits 0', needsBash, () => {
  const { status, stdout } = runTally(null);

  assert.equal(status, 0, 'a diagnostic must not fail the job it is diagnosing');

  const line = tallyLine(stdout);
  assert.equal(
    line,
    '[e2e-contention] refresh_total=unavailable refresh_429=unavailable session_evicted=unavailable',
  );
  assert.doesNotMatch(line, /=0\b/, '"not measured" must never render as "measured zero"');
  assert.match(stdout, /\[e2e-contention\] reason: /, 'an unavailable tally must say why');
});

// ─── `--gate` — because a GREEN run publishes no bundle (SC-007) ─────────────────────────────────
//
// Measured 2026-08-10: runs 1622 and 1623 both passed, and bundles 1623/1624--app-e2e do not exist.
// The digest publishes only on failure, so on a green run the tally is emitted and then unreadable.
// If the contention partially returned, retries would absorb it, app-e2e would stay green, and
// `refresh_429 > 0` would never be seen. So the judgement moves into the job.

test('gate passes a clean run and says so', needsBash, () => {
  const log = [auditLine('refresh_attempted'), auditLine('refresh_attempted')].join('\n');
  const { status, stdout } = runTally(log, ['--gate']);

  assert.equal(status, 0);
  assert.equal(tallyLine(stdout), '[e2e-contention] refresh_total=2 refresh_429=0 session_evicted=0');
  assert.match(stdout, /gate passed/);
});

test('gate FAILS on a rate-limited refresh — the contention returning', needsBash, () => {
  const log = [auditLine('refresh_attempted'), auditLine('refresh_rate_limited')].join('\n');
  const { status, stdout } = runTally(log, ['--gate']);

  assert.equal(status, 1, 'a returning contention must fail the job, not just be logged');
  assert.match(stdout, /GATE FAILED/);
  assert.match(stdout, /refresh_429=1/);
  // The message must point at the three things that can regress, and rule out the tempting fix.
  assert.match(stdout, /MAX_E2E_WORKERS/);
  assert.match(stdout, /accessTokenLifespan/);
  assert.match(stdout, /Do NOT silence this by raising the BFF's refresh rate limit/);
});

test('gate FAILS on a session eviction — the mechanism run 1605 refuted, returning', needsBash, () => {
  const log = [auditLine('refresh_attempted'), auditLine('session_evicted')].join('\n');
  const { status, stdout } = runTally(log, ['--gate']);

  assert.equal(status, 1);
  assert.match(stdout, /session_evicted=1/);
});

test('gate does NOT fail on `unavailable` — it cannot cause a false green', needsBash, () => {
  // This step runs after the web E2E and before teardown, so the container exists whenever the suite
  // ran. `unavailable` therefore implies bring-up already failed and the job is red for an upstream
  // cause; failing again would compete with the real story (run 1611, a Keycloak import error).
  const { status, stdout } = runTally(null, ['--gate']);

  assert.equal(status, 0);
  assert.match(stdout, /refresh_total=unavailable/);
  assert.doesNotMatch(stdout, /gate passed/, 'an unmeasured run must not claim the gate passed');
});

test('without --gate the script still never fails, whatever it finds', needsBash, () => {
  // The diagnostic contract is unchanged: default mode is exit-0 by design, so the tally can be read
  // on a failing run without adding a second, competing failure.
  const log = [auditLine('refresh_rate_limited'), auditLine('session_evicted')].join('\n');
  assert.equal(runTally(log).status, 0);
});

// ─── The wiring. A correct script in the wrong place reports a structural zero. ──────────────────

test('app-ci runs the tally through ci-log-step, so the digest ranks it above container logs', () => {
  const yml = readFileSync(APP_CI, 'utf8');
  assert.match(
    yml,
    /ci-log-step\.sh\s+e2e-contention-tally\s+bash\s+scripts\/e2e-contention-tally\.sh/,
    'the tally must travel as a `step:` source — the digest keeps only 3 sources and ranks step: 0',
  );
});

test('app-ci invokes the tally with --gate, and does NOT swallow its exit status', () => {
  // Two ways to make the gate decorative without breaking anything visible: drop `--gate` (back to
  // advisory, unreadable on a green run), or restore `continue-on-error: true` (the step reports its
  // failure and the job passes anyway). Both leave a step that still runs and still prints, so
  // neither is noticeable by reading the log.
  const block = tallyStepBlock(readFileSync(APP_CI, 'utf8'));

  assert.match(block, /e2e-contention-tally\.sh\s+--gate/, 'the step must run the script in gate mode');
  assert.doesNotMatch(
    block,
    /continue-on-error:\s*true/,
    'continue-on-error makes the gate advisory again — the exact state SC-007 could not verify',
  );
});

/**
 * The tally step as its own block of YAML lines: from its `- name:` down to (not including) the
 * next step's `- name:`.
 *
 * Anchored on the `run:` line that actually invokes the script, then walked BACK to the owning
 * `- name:`. Two cheaper approaches were tried and both lie:
 *   * `indexOf('e2e-contention-tally')` hits the string inside this step's own explanatory comment
 *     first, so a fixed-size window around it inspects prose rather than YAML keys;
 *   * on a file with no such step at all, `indexOf` returns -1 and a negative-offset `slice` yields
 *     an unrelated tail of the file, where `if: always()` matches some OTHER step — a test that
 *     passes precisely when the thing it checks is absent. (Both were caught in this file's RED run.)
 */
function tallyStepBlock(yml) {
  const lines = yml.split(/\r?\n/);
  const runAt = lines.findIndex((l) => /ci-log-step\.sh\s+e2e-contention-tally\b/.test(l));
  assert.notEqual(runAt, -1, 'no step in app-ci.yml invokes scripts/e2e-contention-tally.sh');

  let start = runAt;
  while (start > 0 && !/^\s*-\s+name:/.test(lines[start])) start -= 1;
  assert.ok(/^\s*-\s+name:/.test(lines[start]), 'the tally run: line has no owning `- name:` step');

  let end = runAt + 1;
  while (end < lines.length && !/^\s*-\s+name:/.test(lines[end])) end += 1;

  return lines.slice(start, end).join('\n');
}

test('the tally step is always() — a passing run\'s counts are the proof the contention is gone', () => {
  const block = tallyStepBlock(readFileSync(APP_CI, 'utf8'));

  assert.match(
    block,
    /^\s*if:\s*(\$\{\{\s*)?always\(\)/m,
    'the tally step needs if: always() — otherwise a green run discards the counts that prove it',
  );
});

test('the tally runs AFTER the web E2E and BEFORE teardown removes the container it reads', () => {
  const lines = readFileSync(APP_CI, 'utf8').split(/\r?\n/);

  // Anchored on the `run:` INVOCATION, never on the bare string `e2e-contention-tally`: that string
  // also appears in this step's explanatory comment, and in the reference to this very test file.
  // A `yml.indexOf('e2e-contention-tally')` therefore finds the PROSE first. Measured: with the step
  // physically relocated below both teardown steps, the indexOf version still reported the correct
  // order, because the comment it matched had stayed behind. It passed a mutation that breaks the
  // exact trap this assertion exists to guard.
  const at = (re) => lines.findIndex((l) => re.test(l));

  const webE2e = at(/- name: Web E2E \(Playwright container/);
  const tally = at(/ci-log-step\.sh\s+e2e-contention-tally\b/);
  const teardown = at(/- name: Tear down CI stacks \(always\)/);

  assert.ok(webE2e !== -1, 'no Web E2E step');
  assert.ok(tally !== -1, 'no tally invocation');
  assert.ok(teardown !== -1, 'no teardown step');

  assert.ok(
    webE2e < tally,
    `the tally must run after the web E2E (web E2E at line ${webE2e + 1}, tally at ${tally + 1}), ` +
      'or it measures an unfinished run',
  );
  assert.ok(
    tally < teardown,
    `the tally must run before teardown (tally at line ${tally + 1}, teardown at ${teardown + 1}) — ` +
      'afterwards the BFF container is gone and every count reads `unavailable` for a structural ' +
      'reason that looks nothing like a real measurement',
  );
});
