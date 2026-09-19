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
import { readFileSync, readdirSync } from 'node:fs';
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

// ── Item #484 — the expiry check must run even when the GATE above it went red ───────────────────
//
// This step sat immediately after the CVE gate carrying a bare `if: github.event_name ==
// 'schedule'`. A failed step skips every later step that is not `always()`-guarded, so on any week
// the gate went red the weekly expiry warning did not run — the week it is most likely to have
// something to say.
//
// Caught by the item #418 recorder on its first live schedule run. Run 3521, the 2026-09-18 weekly
// cron, failed the gate on three amqp091-go CRITICALs and posted:
//
//   infra-image-scan/expiry  success  "event_name=schedule expiry_step=skipped"
//
// `event_name=schedule` proves the `if:` evaluated TRUE, so the skip can only have come from the
// upstream failure.

test('(#484) the expiry check runs regardless of the gate outcome, and STILL never on a PR', () => {
  const step = expiryStep(load('infra-image-scan.yml'));
  const cond = String(step.if ?? '');

  assert.match(
    cond,
    /always\(\)/,
    'the --check-expiring step must be `always()`-guarded, or a red CVE gate skips it — which is ' +
      `exactly the week it matters most (item #484). Found if: ${JSON.stringify(step.if)}`,
  );
  // Both halves, together. `always()` alone would run it on every pull request and block them all
  // the moment an allowlist entry entered the 14-day window (FR-021/SC-007).
  assert.match(
    cond,
    /github\.event_name\s*==\s*'schedule'/,
    'the schedule guard must survive inside the always() — it is what keeps this off pull requests',
  );
});

test('(#484) a CANCELLED run is suppressed IN THE STEP, the way the failure digest does it', () => {
  // `always()` also runs on a cancelled run, and this job is `cancel-in-progress: true`. A sweep
  // superseded before Checkout completed would reach this step with an empty workspace, fail on the
  // missing scripts, and turn `cancelled` into `failure` for a commit that was never broken — the
  // same fault FR-001a made the digest suppress.
  //
  // Suppressed from `job.status` inside the body rather than with `!cancelled()` in the `if:`,
  // because `cancelled()` has never been used on this Forgejo while `job.status` in `env:` is
  // proven across nine workflows. This pins the decision so it is not "tidied" into an untested
  // expression later.
  const step = expiryStep(load('infra-image-scan.yml'));
  const envValues = Object.values(step.env ?? {}).map(String);
  assert.ok(
    envValues.some((v) => v.includes('job.status')),
    'the expiry step must carry job.status into its env so a cancelled run can be suppressed',
  );
  assert.match(
    runText(step),
    /cancelled/,
    'the step body must actually act on that value — carrying it and ignoring it is worse than neither',
  );
});

test('(#484) the gate is addressable, so "if: false" is distinguishable from "an earlier step failed"', () => {
  // `steps.<id>.outcome == 'skipped'` CONFLATES the two by construction. On run 3521 the status was
  // readable only because it happened to carry `event_name` beside it — luck of composition, on an
  // instrument built specifically to stop inferring this step's execution. The gate's own outcome
  // is the second measured field that closes it.
  const scan = load('infra-image-scan.yml');
  const gate = stepsOf(scan, 'infra-image-scan').filter((s) =>
    runText(s).includes('check-infra-image-findings.mjs') && !runText(s).includes('--'),
  );
  assert.equal(gate.length, 1, 'expected exactly one un-flagged gate invocation in the infra-image-scan job');
  assert.ok(
    typeof gate[0].id === 'string' && gate[0].id.length > 0,
    'the CVE gate step needs an `id:` so the recorder can carry its outcome',
  );

  const reporter = reporterStep(scan)[0];
  const envValues = Object.values(reporter.env ?? {}).map(String);
  assert.ok(
    envValues.some((v) => v.includes(`steps.${gate[0].id}.outcome`)),
    'the expiry recorder must carry the GATE outcome too — `expiry_step=skipped` alone cannot say ' +
      'whether the `if:` was false or an earlier step failed',
  );
});

// ── Item #485 — the weekly sweep publishes a verdict that can actually be red ────────────────────

test('(#485) the weekly sweep publishes its verdict as a commit status', () => {
  const scan = load('infra-image-scan.yml');
  const found = stepsOf(scan, 'infra-image-scan').filter((s) => runText(s).includes('publish-sweep-verdict.mjs'));
  assert.equal(found.length, 1, 'expected exactly one step publishing the infra-image-scan/weekly status');
  const step = found[0];
  const cond = String(step.if ?? '');

  assert.match(cond, /always\(\)/, 'a verdict publisher that skips when the sweep fails reports only good news');
  assert.match(
    cond,
    /github\.event_name\s*==\s*'schedule'/,
    'only the WEEKLY sweep needs this — push and pull_request already post the real required context',
  );
  assert.equal(step['continue-on-error'], true, 'a bookkeeping POST must not be able to fail the sweep');

  // The DECISION lives in scripts/publish-sweep-verdict.mjs and is unit-tested there. It was inline
  // shell first, and a mutation flipping `state=failure` to `state=success` in one branch went
  // UNDETECTED by a regexp over the step body — which is why it is a script now. This asserts the
  // wiring only; sweepStatusFor's behaviour is pinned in publish-sweep-verdict.test.mjs.
  assert.match(
    runText(step),
    /publish-sweep-verdict\.mjs/,
    'the weekly verdict must run the unit-tested publisher, not re-derive the mapping inline',
  );

  // "The sweep found blocking CVEs" and "the sweep could not run" are different facts — a
  // fail-closed Trivy error is a red job that found NOTHING, and reporting it as a CVE verdict
  // would be a claim about images nobody scanned.
  const envValues = Object.values(step.env ?? {}).map(String);
  for (const id of ['gate', 'scan']) {
    assert.ok(
      envValues.some((v) => v.includes(`steps.${id}.outcome`)),
      `the weekly verdict must measure steps.${id}.outcome — without it a Trivy failure and a CVE ` +
        'finding are indistinguishable in the status it publishes',
    );
  }
});

test('(#484/#485) every steps.<id>.outcome reference resolves to a step that HAS that id', () => {
  // THIS TEST EXISTS BECAUSE THE GUARDS ABOVE DID NOT CATCH IT. During mutation testing, deleting
  // `id: scan` from the Trivy step left every assertion green: they check that the RECORDER
  // mentions `steps.scan.outcome`, which is just a string in an env value, and never that anything
  // answers to `scan`. A dangling reference does not error — the runner resolves it to the empty
  // string — so the status would have published `scan=<unset>` for ever and the distinction it was
  // added to make would have been silently gone.
  const dir = resolve(REPO_ROOT, '.forgejo/workflows');
  const dangling = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    const wf = parseYaml(readFileSync(resolve(dir, file), 'utf8'));
    for (const [jobName, job] of Object.entries(wf?.jobs ?? {})) {
      const steps = job?.steps ?? [];
      const ids = new Set(steps.map((st) => st?.id).filter(Boolean));
      for (const st of steps) {
        const text = `${runText(st)} ${Object.values(st?.env ?? {}).map(String).join(' ')} ${String(st?.if ?? '')}`;
        for (const [, id] of text.matchAll(/steps\.([A-Za-z0-9_-]+)\.(?:outcome|conclusion|outputs)/g)) {
          if (!ids.has(id)) dangling.push(`${file}:${jobName} — "${st.name ?? '(unnamed)'}" references steps.${id}, but no step in that job has id: ${id}`);
        }
      }
    }
  }
  assert.deepEqual(
    dangling,
    [],
    `these references resolve to the EMPTY STRING at runtime rather than erroring:\n  ${dangling.join('\n  ')}`,
  );
});

test('(#485) the weekly status CANNOT satisfy or block the required context', () => {
  // Branch protection requires the glob `infra-image-scan / infra-image-scan*`. This status is
  // deliberately named so it does NOT match — the same reason infra-image-scan/expiry has never
  // blocked a merge. If this ever starts matching, a bookkeeping POST becomes a merge gate.
  const glob = 'infra-image-scan / infra-image-scan*';
  const rx = new RegExp(`^${glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  for (const ctx of ['infra-image-scan/weekly', 'infra-image-scan/expiry']) {
    assert.ok(!rx.test(ctx), `${ctx} matches the required glob — it would become a merge gate`);
  }
  // The control: the real context DOES match, so the regexp above is testing something.
  assert.ok(rx.test('infra-image-scan / infra-image-scan'), 'the glob no longer matches the real context');
});

// ── Item #484's cross-workflow audit — the general rule ──────────────────────────────────────────

test('(#484) every status-posting / digest step in EVERY workflow is always()-guarded', () => {
  // The audit criterion, made mechanical. A reporter ordered after a failable step without
  // `always()` reports nothing on precisely the runs worth reporting — the #484 fault, stated
  // generally rather than pinned to the one place it was found.
  //
  // Detected by BEHAVIOUR (the step POSTs a commit status, or runs the failure digest), not by
  // name: "Publish prod APK to the package registry" in cd-deploy.yml is real work that MUST skip
  // when the build fails, and a name-based rule would have demanded `always()` there and published
  // an APK from a red build.
  //
  // This found renovate.yml's `Publish dispatch mode (item #268)`, which sat after four setup steps
  // that can fail — so a dispatch whose toolchain died recorded nothing, and an unrecorded dispatch
  // mode is exactly the absence item #268 built that step to end.
  const dir = resolve(REPO_ROOT, '.forgejo/workflows');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
  assert.ok(files.length >= 8, `expected the workflow set, found ${files.length} — is the path right?`);

  const offenders = [];
  let reporters = 0;
  for (const file of files) {
    const wf = parseYaml(readFileSync(resolve(dir, file), 'utf8'));
    for (const [jobName, job] of Object.entries(wf?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const run = runText(step);
        if (!/\/statuses\/|ci-failure-digest\.mjs|publish-sweep-verdict\.mjs/.test(run)) continue;
        reporters += 1;
        const guarded = /always\(\)/.test(String(step.if ?? '')) && step['continue-on-error'] === true;
        if (!guarded) {
          offenders.push(`${file}:${jobName} — ${step.name ?? '(unnamed)'} (if: ${JSON.stringify(step.if)}, continue-on-error: ${step['continue-on-error']})`);
        }
      }
    }
  }

  // Without this the assertion below is vacuously true the moment the detector stops matching —
  // a guard that has quietly stopped looking at anything is the fault it was written to catch.
  assert.ok(reporters >= 20, `the reporter detector matched only ${reporters} steps; it has stopped finding them`);
  assert.deepEqual(
    offenders,
    [],
    `these steps POST a status or publish a digest but are not always()-guarded, so they go silent ` +
      `on the runs that matter:\n  ${offenders.join('\n  ')}`,
  );
});
