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
// It asserts the WIRING, not the runner's `if:` evaluation. That residual is small and named.

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
