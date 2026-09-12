// Feature 057 — where the two new gates are WIRED, asserted statically.
//
// Both facts below are invisible from a job's green tick, which is the whole problem:
//
//   * The weekly `--check-expiring` step MUST NOT run on a pull request. `infra-image-scan` also
//     serves `pull_request` (un-path-gated, so it posts the required context on every PR), so a
//     missing or wrong `if:` guard would block every PR the moment an entry entered the 14-day
//     window. Today the check exits 0, so a wrong guard produces a GREEN PR now and a blocked one a
//     fortnight later — the failure is scheduled, not immediate.
//
//   * The override-consistency gate MUST run on pull requests. An absent step and a passing step
//     look identical from the job's tick.
//
// The intended verification (T031) was to read a real pull-request run's STEP LIST. This Forgejo
// build exposes no jobs/steps endpoint — `/actions/runs/<id>/jobs` is 404 and the UI's internal
// route is not reachable over the API — so the step list cannot be read back. This test is the
// durable substitute: it pins the wiring so a later edit that drops the guard, or drops the step,
// fails here rather than two weeks after someone dates an allowlist entry.
//
// It asserts the WIRING, not the runner's `if:` evaluation. That residual is no longer open: the
// job now publishes an `infra-image-scan/expiry` commit status carrying the MEASURED
// `github.event_name` and the measured outcome of the step, and the assertions at the foot of
// this file pin that recorder. See the item #418 block below for what the residual cost while it
// stood — a correct gate was very nearly "fixed" on the strength of the wrong API field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const load = (rel) => parseYaml(readFileSync(resolve(REPO_ROOT, '.forgejo/workflows', rel), 'utf8'));
const stepsOf = (workflow, job) => workflow?.jobs?.[job]?.steps ?? [];
const runText = (step) => (typeof step?.run === 'string' ? step.run : '');

test('the weekly expiry check covers BOTH allowlists and is guarded to schedule events only', () => {
  const scan = load('infra-image-scan.yml');
  const steps = stepsOf(scan, 'infra-image-scan');

  const expiry = steps.filter((s) => runText(s).includes('--check-expiring'));
  assert.equal(
    expiry.length,
    1,
    'expected exactly one step invoking --check-expiring in the infra-image-scan job',
  );

  const step = expiry[0];
  assert.ok(
    runText(step).includes('check-sast-findings.mjs --check-expiring'),
    'the expiry step must cover the SAST allowlist',
  );
  assert.ok(
    runText(step).includes('check-infra-image-findings.mjs --check-expiring'),
    'the expiry step must cover the infra-image allowlist',
  );

  // The load-bearing line. Without it a red expiry check blocks every pull request.
  assert.match(
    String(step.if ?? ''),
    /github\.event_name\s*==\s*'schedule'/,
    `the --check-expiring step must be guarded to schedule events; found if: ${JSON.stringify(step.if)}`,
  );

  // And that job really does serve pull requests — the reason the guard exists at all. If this ever
  // stops being true the guard is merely harmless, but the assertion above would stop meaning
  // anything, so it is checked rather than assumed.
  assert.ok(
    Object.prototype.hasOwnProperty.call(scan.on ?? {}, 'pull_request'),
    'infra-image-scan no longer serves pull_request — re-derive whether the schedule guard is still the right protection',
  );
});

test('no OTHER workflow runs --check-expiring on a pull-request trigger', () => {
  // A second, unguarded copy elsewhere would reintroduce the fault while this file still passed.
  for (const name of ['guardrails.yml', 'app-ci.yml', 'cd-deploy.yml', 'renovate.yml']) {
    const wf = load(name);
    for (const [jobName, job] of Object.entries(wf?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        assert.ok(
          !runText(step).includes('--check-expiring'),
          `${name}:${jobName} invokes --check-expiring; only the schedule-guarded step in infra-image-scan.yml may`,
        );
      }
    }
  }
});

test('the override-consistency gate DOES run on pull requests, selftest-then-scan', () => {
  const guardrails = load('guardrails.yml');
  const steps = stepsOf(guardrails, 'naming');

  const gate = steps.filter((s) => runText(s).includes('check-override-consistency.mjs'));
  assert.equal(gate.length, 1, 'expected the override-consistency gate in guardrails.yml naming job');

  const run = runText(gate[0]);
  assert.match(run, /check-override-consistency\.mjs --selftest/, 'must prove detection before trusting the scan');
  assert.match(run, /check-override-consistency\.mjs\s*$|check-override-consistency\.mjs\s*\n/, 'must also run the real scan');

  // Unlike the expiry check this one is NOT event-guarded — blocking a half-bumped proposal before
  // merge is its entire purpose (FR-018).
  assert.equal(
    gate[0].if,
    undefined,
    'the override-consistency gate must not be event-guarded — it exists to block half-bumps on pull requests',
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(guardrails.on ?? {}, 'pull_request'),
    'guardrails no longer runs on pull_request, so the override gate would not block a proposal',
  );
});

// ── Item #418 — close the residual the header above names ────────────────────────────────────────
//
// The guard at the top pins the `if:` EXPRESSION. It cannot pin the runner's EVALUATION of it, and
// that gap was nearly fatal: item #418 read the runs API, saw `event` = "push" on every cron run,
// and concluded the step had never once executed. The API carries TWO fields — `trigger_event`
// ("schedule", the real trigger) and `event` ("push", the synthesized payload type) — and the
// runner's `github.event_name` follows `trigger_event`. Measured 2026-09-12 over all 68 scheduled
// runs since 2026-07-31: trigger_event is "schedule" for every one of them, event is "push" for
// every one of them.
//
// The step HAD been running: it went red on 2026-08-14, 08-21 and 08-28 — the first three Fridays
// after it was added (a0f62e18, 08-13) — and green again on 09-04 once f7fea0f6 (08-30) deleted the
// five stale suppressions, which is exactly the red/green history that commit records. Nothing else
// in the job invokes `--check-expiring`, and an unmatched entry fails in no other mode.
//
// So the `if:` was right and the conclusion drawn from the API was wrong. What was missing is a
// MEASUREMENT — a per-run record of what `github.event_name` actually was and whether the step
// actually ran, readable without logs (this forge exposes no log or jobs endpoint). These
// assertions pin that recorder.

const expiryStep = (scan) =>
  stepsOf(scan, 'infra-image-scan').filter((s) => runText(s).includes('--check-expiring'))[0];
const reporterStep = (scan) =>
  stepsOf(scan, 'infra-image-scan').filter((s) => runText(s).includes('infra-image-scan/expiry'));

test('the expiry step is addressable, so its execution can be recorded rather than inferred', () => {
  const step = expiryStep(load('infra-image-scan.yml'));
  assert.ok(step, 'the --check-expiring step is gone');
  assert.ok(
    typeof step.id === 'string' && step.id.length > 0,
    'the --check-expiring step needs an `id:` so a later step can read steps.<id>.outcome; ' +
      'without it nothing can distinguish a run that skipped it from one that ran it',
  );
});

test('a reporter publishes the MEASURED event_name and expiry-step outcome as a commit status', () => {
  const scan = load('infra-image-scan.yml');
  const expiry = expiryStep(scan);
  const found = reporterStep(scan);

  assert.equal(found.length, 1, 'expected exactly one step publishing the infra-image-scan/expiry status');
  const step = found[0];
  const run = runText(step);

  // Both values must be carried through as RAW measurements. Interpolating them into the step env
  // (rather than restating a belief about them in a comment) is what makes the status evidence.
  const env = step.env ?? {};
  const envValues = Object.values(env).map(String);
  assert.ok(
    envValues.some((v) => v.includes('github.event_name')),
    'the reporter must carry github.event_name into its env so the status records what the runner ACTUALLY saw',
  );
  assert.ok(
    envValues.some((v) => v.includes(`steps.${expiry.id}.outcome`)),
    `the reporter must carry steps.${expiry.id}.outcome so a skip is distinguishable from a run`,
  );
  assert.match(run, /statuses\//, 'the reporter must POST a commit status — the only channel this forge exposes to a reader');
});

test('the reporter cannot be blinded by the very condition it exists to measure', () => {
  const scan = load('infra-image-scan.yml');
  const step = reporterStep(scan)[0];
  assert.ok(step, 'the infra-image-scan/expiry reporter is gone — nothing records whether the step ran');
  const cond = String(step.if ?? '');

  // The whole point. A recorder gated on `event_name == 'schedule'` records nothing on the run where
  // that expression is false — which is precisely the run you need the record for.
  assert.ok(
    !/github\.event_name\s*==\s*'schedule'/.test(cond),
    `the reporter must not be gated on the expression it measures; found if: ${JSON.stringify(step.if)}`,
  );
  assert.match(
    cond,
    /always\(\)/,
    'the reporter must run even when the scan or the gate above failed — a failed run is when the record matters most',
  );
  assert.match(
    cond,
    /github\.event_name\s*!=\s*'pull_request'/,
    'the reporter must stay off pull requests: a status per PR is noise, and the cron is what is being measured',
  );
  assert.equal(
    step['continue-on-error'],
    true,
    'the reporter is observability, never a gate — it must not be able to fail the job it observes',
  );
});
