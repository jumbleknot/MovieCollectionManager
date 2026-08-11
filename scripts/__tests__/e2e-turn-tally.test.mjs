// Feature 054 US3 — the run-health `verdict`, and the ways it could lie.
//
// Roughly one `app-e2e` run in seven COLLAPSES: every agent/dock spec fails at once, `flaky=0`, and
// the gateway receives about a quarter of its usual traffic while answering everything it does
// receive with 200. The dock shows the member's echoed message and no assistant reply. It is not a
// slow model — slowness leaves a partial response (backlog item #173).
//
// That is indistinguishable from "some tests failed" unless somebody opens the bundle and counts
// gateway POSTs by hand, which is how five stale specs hid for three weeks behind a re-run reflex.
// This script makes the distinction automatic.
//
// Contract: specs/054-app-e2e-reliability-cluster/contracts/run-health-signal.md
//
// Three traps are pinned here rather than trusted, because each produces a WRONG ANSWER rather than
// an obvious break:
//
//   1. `grep -c` exits 1 when it matches nothing, and `ci-log-step.sh` re-raises the wrapped exit
//      code by design. Naive counting turns a zero-POST measurement into a red job — and a zero-POST
//      run is precisely the one worth reporting.
//   2. "Not measured" and "measured zero" are opposite conclusions. An unreadable gateway log, or a
//      missing counts line, must render `indeterminate` — never `collapsed`, which would read as a
//      confident finding drawn from no data.
//   3. The denominator can be absent or zero. A divide-by-zero in bash prints nothing and exits 1;
//      both would be silent.
//
// Deterministic, offline, token-free, node: built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { needsShell } from './shell-probe.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/e2e-turn-tally.sh');
const APP_CI = resolve(REPO_ROOT, '.forgejo/workflows/app-ci.yml');

// Gate ONLY the cases that spawn a shell. The workflow-wiring assertions below read YAML and nothing
// else; gating them too was measured on Windows turning four passes into skips — honest, but broader
// than the condition requires, so four assertions silently lost their coverage. Under-skipping gives
// meaningless failures; over-skipping gives meaningless passes.
const needsBash = needsShell('bash', SCRIPT);

/** One uvicorn access line for the agent endpoint, as the gateway actually writes it. */
const postLine = (status = 200) =>
  `INFO:     172.18.0.4:52344 - "POST /agent/movie-assistant HTTP/1.1" ${status} OK`;

/** The `[e2e-gate]` line the previous step emits — the denominator's only source. */
const gateLine = ({ failed = 0, flaky = 0, passed = 0, didNotRun = 0, skipped = 0 } = {}) =>
  `[e2e-gate] failed=${failed} flaky=${flaky} passed=${passed} did-not-run=${didNotRun} skipped=${skipped}`;

/**
 * Run the tally against fixture logs, bypassing Docker.
 *
 * The file seam is what makes this testable at all: a script that could only read a live container
 * could only be verified by running CI, which is the loop this feature exists to shorten.
 */
function runTally({ gatewayLog, countsLog }) {
  const dir = mkdtempSync(join(tmpdir(), 'turn-tally-'));
  try {
    const env = { ...process.env };
    if (gatewayLog === null) {
      env.E2E_TURN_GATEWAY_LOG_FILE = join(dir, 'no-such-gateway.log');
      env.E2E_TURN_GATEWAY_CONTAINER = 'container-that-does-not-exist-054';
    } else {
      const f = join(dir, 'gateway.log');
      writeFileSync(f, gatewayLog);
      env.E2E_TURN_GATEWAY_LOG_FILE = f;
    }
    if (countsLog === null) {
      env.E2E_TURN_COUNTS_FILE = join(dir, 'no-such-counts.log');
    } else {
      const f = join(dir, 'counts.log');
      writeFileSync(f, countsLog);
      env.E2E_TURN_COUNTS_FILE = f;
    }
    const res = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The single `[e2e-turns]` line, which must be present exactly once. */
function turnLine(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith('[e2e-turns] gateway_posts='));
  assert.equal(lines.length, 1, `expected exactly one tally line, got ${lines.length}:\n${stdout}`);
  return lines[0];
}

const verdictOf = (stdout) => turnLine(stdout).match(/verdict=(\w+)/)?.[1];

// --- The two populations, from the runs that actually measured them -------------------------------

test('a HEALTHY run is classified healthy — run 1619, 155 posts over 177 tests', needsBash, () => {
  const r = runTally({
    gatewayLog: Array.from({ length: 155 }, () => postLine()).join('\n'),
    countsLog: gateLine({ failed: 1, flaky: 5, passed: 171 }),
  });
  assert.equal(r.status, 0);
  assert.equal(verdictOf(r.stdout), 'healthy');
  assert.match(turnLine(r.stdout), /gateway_posts=155/);
  assert.match(turnLine(r.stdout), /tests_executed=177/);
  assert.match(turnLine(r.stdout), /posts_per_100_tests=87/);
});

test('a COLLAPSED run is classified collapsed — run 1633, 39 posts over 177 tests', needsBash, () => {
  const r = runTally({
    gatewayLog: Array.from({ length: 39 }, () => postLine()).join('\n'),
    countsLog: gateLine({ failed: 30, flaky: 0, passed: 147 }),
  });
  assert.equal(r.status, 0);
  assert.equal(verdictOf(r.stdout), 'collapsed');
  assert.match(turnLine(r.stdout), /posts_per_100_tests=22/);
});

test('the highest measured COLLAPSED run is still collapsed — 1622, 56 posts', needsBash, () => {
  // 32 posts/100 tests. The closest a collapsed run got to the floor of 50; if this one is
  // misclassified the threshold is wrong, not the run.
  const r = runTally({
    gatewayLog: Array.from({ length: 56 }, () => postLine()).join('\n'),
    countsLog: gateLine({ failed: 26, flaky: 0, passed: 151 }),
  });
  assert.equal(verdictOf(r.stdout), 'collapsed');
});

test('the lowest measured HEALTHY run is still healthy — 1619 at 88, floor is 50', needsBash, () => {
  const r = runTally({
    gatewayLog: Array.from({ length: 156 }, () => postLine()).join('\n'),
    countsLog: gateLine({ failed: 1, flaky: 5, passed: 171 }),
  });
  assert.equal(verdictOf(r.stdout), 'healthy');
});

test('a run with NO agent traffic at all is collapsed, not indeterminate', needsBash, () => {
  // Zero is a MEASUREMENT here — the gateway log was readable and contained no agent POSTs. That is
  // the most extreme collapse, and reporting it as "could not tell" would bury the clearest signal
  // the detector can produce. It is also the `grep -c` exit-1 case.
  const r = runTally({
    gatewayLog: 'INFO:     172.18.0.4:52344 - "GET /health HTTP/1.1" 200 OK',
    countsLog: gateLine({ failed: 177, flaky: 0, passed: 0 }),
  });
  assert.equal(r.status, 0, 'a zero count failed the step — the grep -c exit-1 trap');
  assert.equal(verdictOf(r.stdout), 'collapsed');
  assert.match(turnLine(r.stdout), /gateway_posts=0/);
});

// --- Not-measured must never render as measured --------------------------------------------------

test('an unreadable gateway log is INDETERMINATE, never collapsed', needsBash, () => {
  const r = runTally({ gatewayLog: null, countsLog: gateLine({ passed: 177 }) });
  assert.equal(r.status, 0);
  assert.equal(verdictOf(r.stdout), 'indeterminate');
  assert.match(r.stdout, /reason:/, 'indeterminate was reported without naming why');
});

test('a MISSING counts line is INDETERMINATE — no denominator, no verdict', needsBash, () => {
  const r = runTally({ gatewayLog: postLine(), countsLog: null });
  assert.equal(r.status, 0);
  assert.equal(verdictOf(r.stdout), 'indeterminate');
});

test('a counts log with no [e2e-gate] line is INDETERMINATE', needsBash, () => {
  const r = runTally({ gatewayLog: postLine(), countsLog: 'some unrelated step output\n' });
  assert.equal(r.status, 0);
  assert.equal(verdictOf(r.stdout), 'indeterminate');
});

test('ZERO tests executed is INDETERMINATE, not a divide-by-zero', needsBash, () => {
  // Reachable when the web suite never started. Bash division by zero prints nothing and exits 1 —
  // silent in both directions.
  const r = runTally({ gatewayLog: postLine(), countsLog: gateLine({}) });
  assert.equal(r.status, 0, 'a zero denominator failed the step');
  assert.equal(verdictOf(r.stdout), 'indeterminate');
});

// --- Counting precision ---------------------------------------------------------------------------

test('only agent POSTs count — health checks and other verbs are excluded', needsBash, () => {
  const r = runTally({
    gatewayLog: [
      postLine(),
      postLine(),
      'INFO:     172.18.0.4:52344 - "GET /agent/movie-assistant HTTP/1.1" 405 Method Not Allowed',
      'INFO:     172.18.0.4:52344 - "GET /health HTTP/1.1" 200 OK',
      'INFO:     172.18.0.4:52344 - "POST /some/other/path HTTP/1.1" 200 OK',
    ].join('\n'),
    countsLog: gateLine({ passed: 100 }),
  });
  assert.match(turnLine(r.stdout), /gateway_posts=2/);
});

test('a non-200 agent POST still counts — it was SENT, which is what is being measured', needsBash, () => {
  // The collapse signature is turns not being sent at all. A 500 means the turn left the client and
  // reached the gateway, which is the opposite finding, so excluding it would hide the distinction
  // the detector exists to draw.
  const r = runTally({
    gatewayLog: [postLine(200), postLine(500)].join('\n'),
    countsLog: gateLine({ passed: 100 }),
  });
  assert.match(turnLine(r.stdout), /gateway_posts=2/);
});

test('the script NEVER exits non-zero — it labels, it does not gate', needsBash, () => {
  // A collapsed run already fails on its test failures. Failing it a second time adds nothing and
  // buys a new false-failure mode. Asserted across every classification, not just the happy one.
  for (const fixture of [
    { gatewayLog: Array.from({ length: 155 }, () => postLine()).join('\n'), countsLog: gateLine({ passed: 177 }) },
    { gatewayLog: postLine(), countsLog: gateLine({ passed: 177 }) },
    { gatewayLog: null, countsLog: null },
    { gatewayLog: '', countsLog: gateLine({}) },
  ]) {
    assert.equal(runTally(fixture).status, 0, `exited non-zero for ${JSON.stringify(fixture).slice(0, 60)}`);
  }
});

// --- Workflow wiring. No shell — deliberately NOT gated on `needsBash`. ---------------------------

test('app-ci runs the turn tally through ci-log-step.sh', () => {
  const yaml = readFileSync(APP_CI, 'utf8');
  assert.match(yaml, /ci-log-step\.sh e2e-turn-tally/,
    'the tally is not routed through ci-log-step.sh, so it never becomes a `step:` source the digest can rank');
});

// These three anchor on the RUN COMMANDS and step headers, never on prose. Both assertions here
// first failed against a correctly-wired workflow because `indexOf` matched a COMMENT — the
// contention tally's own comment says it "must precede `Tear down CI stacks`", 3 kB earlier in the
// file. A grep that matches the wrong thing is the trap this whole feature is about; it is not less
// of one for being in the test rather than in the code.
const RUN_TURN_TALLY = 'bash scripts/e2e-turn-tally.sh';
const RUN_RESULT_GATE = 'node scripts/e2e-failure-set.mjs gate';
const STEP_TEARDOWN = '- name: Tear down CI stacks';

test('the turn tally is always(), so a red run still reports its verdict', () => {
  const yaml = readFileSync(APP_CI, 'utf8');
  const at = yaml.indexOf(RUN_TURN_TALLY);
  assert.ok(at > -1, 'the turn tally is not invoked in app-ci.yml at all');
  // Walk back to this step's own `- name:` header so the window cannot spill into the step above.
  const stepStart = yaml.lastIndexOf('- name:', at);
  assert.match(yaml.slice(stepStart, at), /if:\s*\$\{\{\s*always\(\)\s*\}\}/,
    'the tally only runs on success — a COLLAPSED run is by definition a failing one, so it would never report');
});

test('the turn tally LABELS rather than gates — no --gate flag', () => {
  // The contention tally takes `--gate` and fails the job; this one deliberately must not. A
  // collapsed run already fails on its test failures, so failing it a second time adds nothing and
  // buys a new false-failure mode.
  const yaml = readFileSync(APP_CI, 'utf8');
  const at = yaml.indexOf(RUN_TURN_TALLY);
  const line = yaml.slice(at, yaml.indexOf('\n', at));
  assert.doesNotMatch(line, /--gate/, 'the run-health verdict was turned into a gate');
});

test('the turn tally runs AFTER the result gate and BEFORE teardown', () => {
  // Two ordering constraints, and both produce a wrong answer rather than a break: the counts line
  // does not exist until the result gate has run, and the gateway container is gone after teardown.
  const yaml = readFileSync(APP_CI, 'utf8');
  const gate = yaml.indexOf(RUN_RESULT_GATE);
  const tally = yaml.indexOf(RUN_TURN_TALLY);
  const teardown = yaml.indexOf(STEP_TEARDOWN, tally);
  assert.ok(gate > -1 && tally > -1 && teardown > -1, 'a required step is missing from app-ci.yml');
  assert.ok(gate < tally, 'the tally runs BEFORE the result gate, so it has no denominator to read');
  assert.ok(tally < teardown, 'the tally runs AFTER teardown, so the gateway container is already gone');
});
