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

  // ZERO turns is a different finding from FEW turns. Measured 2026-08-12: the gateway reported
  // `status=running restarts=0` while /health timed out and it had stopped logging 40 minutes
  // earlier; two full runs were measured against it and both read `collapsed`. Blaming the client
  // for a corpse is worse than no detector, because it is confidently wrong in the direction of an
  // expensive investigation.
  assert.match(r.stdout, /CHECK GATEWAY LIVENESS FIRST/,
    'a zero-turn run pointed at the client without ruling the stack out');
  assert.doesNotMatch(r.stdout, /COLLAPSE SIGNATURE/,
    'the client-side diagnosis was emitted for a run where no turn reached the gateway at all');
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

test('the denominator spans BOTH tiers, so the ratio stays comparable', needsBash, () => {
  // Feature 056 split the suite. The gateway serves every turn the job drives, but the gate tier's
  // counts file holds only its own tests. MEASURED on run #1686: 149 posts over 155 gate tests read
  // as 96 per 100, where the same job pre-split read 83 — the model tier's 22 tests contributed to
  // the numerator and nothing to the denominator. It did not change that verdict, and that is not a
  // reason to leave a measurement wrong: the floor is calibrated against a band, and an inflated
  // ratio drifts out of comparability with it.
  const dir = mkdtempSync(join(tmpdir(), 'turn-tally-tiers-'));
  try {
    const gateway = join(dir, 'gateway.log');
    writeFileSync(gateway, Array.from({ length: 149 }, () => postLine()).join('\n'));
    const gate = join(dir, 'counts.log');
    writeFileSync(gate, gateLine({ failed: 0, flaky: 0, passed: 155 }));
    const model = join(dir, 'counts-model.log');
    writeFileSync(model, gateLine({ failed: 0, flaky: 0, passed: 22 }));

    const run = (env) => spawnSync('bash', [SCRIPT], { env: { ...process.env, ...env }, encoding: 'utf8' });

    const both = run({
      E2E_TURN_GATEWAY_LOG_FILE: gateway,
      E2E_TURN_COUNTS_FILE: gate,
      E2E_TURN_MODEL_COUNTS_FILE: model,
    });
    assert.match(turnLine(both.stdout), /tests_executed=177/, 'the model tier was not added to the denominator');
    assert.match(turnLine(both.stdout), /posts_per_100_tests=84/);

    // On a pull request the model tier does not run. An ABSENT file must add nothing — never read as
    // "zero tests ran", which would be a different claim.
    const gateOnly = run({
      E2E_TURN_GATEWAY_LOG_FILE: gateway,
      E2E_TURN_COUNTS_FILE: gate,
      E2E_TURN_MODEL_COUNTS_FILE: join(dir, 'absent.log'),
    });
    assert.match(turnLine(gateOnly.stdout), /tests_executed=155/, 'an absent model log changed the denominator');
    assert.equal(gateOnly.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a GATE-ONLY run is indeterminate, not collapsed — the floor is calibrated on the full suite', needsBash, () => {
  // MEASURED on PR #181: gate tier alone gave `failed=0 flaky=1 passed=154` — green by every count —
  // and 49 posts over 155 tests = 31 per 100, which the floor of 50 called `collapsed`. The floor was
  // calibrated on a suite INCLUDING the model-decision tests, and those drive most of the turns; the
  // gate keeps 19 agent tests of 41, several doing no model turn at all.
  //
  // A confident wrong label on every pull request would teach people to ignore the field, which is
  // the re-run reflex this script exists to remove. One gate-only sample is not a calibration, so it
  // says so instead of guessing.
  const dir = mkdtempSync(join(tmpdir(), 'turn-tally-gateonly-'));
  try {
    const gateway = join(dir, 'gateway.log');
    writeFileSync(gateway, Array.from({ length: 49 }, () => postLine()).join('\n'));
    const gate = join(dir, 'counts.log');
    writeFileSync(gate, gateLine({ failed: 0, flaky: 1, passed: 154 }));

    const r = spawnSync('bash', [SCRIPT], {
      env: {
        ...process.env,
        E2E_TURN_GATEWAY_LOG_FILE: gateway,
        E2E_TURN_COUNTS_FILE: gate,
        E2E_TURN_MODEL_COUNTS_FILE: join(dir, 'absent.log'),
        // EXPLICIT, not inferred from the absent model log: a local full-suite run has no model log
        // either, and abstaining there would discard the verdict where a developer reads it directly.
        E2E_TURN_TIER: 'gate',
      },
      encoding: 'utf8',
    });

    assert.equal(r.status, 0);
    assert.equal(verdictOf(r.stdout), 'indeterminate',
      'a healthy gate-only run was labelled against a floor calibrated on the full suite');
    assert.doesNotMatch(r.stdout, /COLLAPSE SIGNATURE/,
      'the client-side diagnosis was emitted for a run whose tier simply drives fewer turns');
    assert.match(r.stdout, /calibrated on the FULL suite/, 'the reason does not say why it abstained');
    // The raw numbers are still reported — abstaining from a VERDICT is not abstaining from the data.
    assert.match(turnLine(r.stdout), /gateway_posts=49/);
    assert.match(turnLine(r.stdout), /tests_executed=155/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a LOCAL full-suite run still gets a verdict — no model log is not the same as gate-only', needsBash, () => {
  // The first version of the tier check inferred "gate only" from the model counts file being absent.
  // A local full run (`E2E_TIER` unset, all 177 tests in one selection) has no model log either, so
  // that inference silently abstained exactly where a developer reads the verdict directly.
  const dir = mkdtempSync(join(tmpdir(), 'turn-tally-local-'));
  try {
    const gateway = join(dir, 'gateway.log');
    writeFileSync(gateway, Array.from({ length: 155 }, () => postLine()).join('\n'));
    const gate = join(dir, 'counts.log');
    writeFileSync(gate, gateLine({ failed: 1, flaky: 5, passed: 171 }));
    const r = spawnSync('bash', [SCRIPT], {
      env: {
        ...process.env,
        E2E_TURN_GATEWAY_LOG_FILE: gateway,
        E2E_TURN_COUNTS_FILE: gate,
        E2E_TURN_MODEL_COUNTS_FILE: join(dir, 'absent.log'),
        E2E_TURN_TIER: '',
      },
      encoding: 'utf8',
    });
    assert.equal(verdictOf(r.stdout), 'healthy', 'a local full-suite run lost its verdict');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── item #325 — a provider non-2xx is invisible on every surface that answers "why did this fail" ─
//
// Measured 2026-08-31 (app-e2e run 2450, PR #322): the Anthropic account ran out of credit, the
// Messages API answered HTTP 400 (`invalid_request_error`, "credit balance is too low") — not 402,
// not 429 — and the gateway logged nothing at ERROR. Two tests then timed out waiting for a UI
// affordance and the run reported as a UI failure. The only trace was an INFO-level httpx line for a
// third-party call. The diagnosis took an hour and went down two wrong paths first.
//
// The tally already reads the gateway log, so the count belongs on the line the digest publishes.
const httpx = (code, text) =>
  `INFO     HTTP Request: POST https://api.anthropic.com/v1/messages "HTTP/1.1 ${code} ${text}"`;
const agentPosts = (n) =>
  Array.from({ length: n }, () => 'INFO: POST /agent/movie-assistant HTTP/1.1 200 OK').join('\n');
const COUNTS_100 = '[e2e-gate] failed=0 flaky=0 passed=100\n';
const verdictLine = (stdout) =>
  stdout.split('\n').filter((l) => /^\[e2e-turns\].*\bverdict=/.test(l)).pop() ?? '';

test('(#325a) a clean run reports provider_non2xx=0 — measured zero, stated explicitly', needsBash, () => {
  const gatewayLog = [agentPosts(90), httpx(200, 'OK'), httpx(200, 'OK')].join('\n');
  const r = runTally({ gatewayLog, countsLog: COUNTS_100 });
  assert.match(verdictLine(r.stdout), /provider_non2xx=0\b/,
    `the verdict line does not carry a provider count: ${verdictLine(r.stdout)}`);
});

test('(#325b) an out-of-credit run is COUNTED and the status code is named', needsBash, () => {
  const gatewayLog = [agentPosts(90), httpx(200, 'OK'), httpx(400, 'Bad Request'), httpx(400, 'Bad Request')].join('\n');
  const r = runTally({ gatewayLog, countsLog: COUNTS_100 });
  assert.match(verdictLine(r.stdout), /provider_non2xx=2\b/);
  assert.match(r.stdout, /\b400\b/, 'the status code is not reported, so the class cannot be told apart');
});

test('(#325c) 400 (credit/quota — operator action) reads differently from 429 (retry)', needsBash, () => {
  const credit = runTally({
    gatewayLog: [agentPosts(90), httpx(400, 'Bad Request')].join('\n'),
    countsLog: COUNTS_100,
  }).stdout;
  const rate = runTally({
    gatewayLog: [agentPosts(90), httpx(429, 'Too Many Requests')].join('\n'),
    countsLog: COUNTS_100,
  }).stdout;
  assert.match(credit, /credit|quota|balance/i, 'a 400 does not point at operator action');
  assert.match(rate, /rate limit|retry/i, 'a 429 does not read as retryable');
  assert.notEqual(
    credit.replace(/\d{3}/g, ''), rate.replace(/\d{3}/g, ''),
    'the two classes produce identical prose — they cannot be told apart',
  );
});

test('(#325d) an unreadable gateway log reports UNAVAILABLE, never a confident zero', needsBash, () => {
  // This file's own principle 2: "not measured" and "measured zero" are opposite conclusions.
  const r = runTally({ gatewayLog: null, countsLog: COUNTS_100 });
  const line = verdictLine(r.stdout);
  assert.match(line, /provider_non2xx=unavailable/,
    `an unmeasurable provider count was reported as a number: ${line}`);
});

test('(#325e) the tally still always exits 0 — counting must never redden a job', needsBash, () => {
  for (const gatewayLog of [agentPosts(90), [agentPosts(90), httpx(400, 'Bad Request')].join('\n')]) {
    assert.equal(runTally({ gatewayLog, countsLog: COUNTS_100 }).status, 0);
  }
});
