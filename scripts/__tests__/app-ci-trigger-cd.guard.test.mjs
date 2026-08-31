// Item #230 — the `trigger-cd` wiring, asserted statically.
//
// WHY A TEST AND NOT A COMMENT. The decision itself is pinned by cd-dispatch-gate.test.mjs, but a
// pure function nothing calls is decoration. Every assertion below is a way the job could keep its
// green tick while the fix stopped applying, and this forge cannot tell those apart: it exposes no
// jobs/steps endpoint, and `trigger-cd` is ADVISORY — a run that declined to dispatch and a run that
// deployed look identical from the outside. That indistinguishability is the reason item #230 sat
// unnoticed for a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = resolve(REPO_ROOT, '.forgejo/workflows/app-ci.yml');

const text = readFileSync(WORKFLOW, 'utf8');
const workflow = parseYaml(text);

const job = () => {
  const j = workflow?.jobs?.['trigger-cd'];
  assert.ok(j, 'app-ci has no trigger-cd job — every assertion in this file would pass vacuously');
  return j;
};
const steps = () => {
  const s = job().steps ?? [];
  assert.ok(s.length > 0, 'trigger-cd has no steps');
  return s;
};

test('every push to main runs app-ci, so every merge offers a trigger-cd', () => {
  // The second half of item #230. PR #228 was config-only, so the `push: paths:` filter kept app-ci
  // off its merge entirely — no app-ci contexts, therefore no trigger-cd job, therefore no
  // replacement trigger for the deploy the superseded commit did not get. "The newer commit carries
  // it" is only true if the newer commit runs at all.
  //
  // The heavy jobs are still gated: app-e2e and dast consume `changes.outputs.app`, exactly as they
  // do on a pull request. What was removed is the WORKFLOW-level filter, not the job-level one.
  assert.equal(
    workflow?.on?.push?.paths,
    undefined,
    'the push trigger has a `paths:` filter again. A config-only merge then runs no app-ci and ' +
      'offers no trigger-cd, so an app commit it supersedes is never deployed by anything — item ' +
      '#230. Gate the expensive jobs on `needs.changes.outputs.app` instead; the deployable-path ' +
      'knowledge lives in DEPLOYABLE_PATHS in scripts/cd-dispatch-gate.mjs.',
  );
  assert.deepEqual(workflow?.on?.push?.branches, ['main'], 'app-ci must still be main-only on push');
});

test('the deploy decision is delegated to cd-dispatch-gate, not inlined', () => {
  // The inline form was `const bad = g.filter(([, st]) => st !== "success")`, which reads a CANCELLED
  // run's contexts — reported as `failure` — as a broken build. Anything that reads raw statuses
  // here re-introduces that; the shared classification in ci-status.mjs is the tested one.
  const run = steps().map((s) => s.run ?? '').join('\n');
  assert.match(run, /scripts\/cd-dispatch-gate\.mjs/, 'trigger-cd no longer calls the deploy gate');
  assert.doesNotMatch(
    run,
    /st\s*!==\s*["']success["']/,
    'the raw-status comparison is back. A cancelled run reports `failure` for a commit that was ' +
      'never broken — that is item #230 itself.',
  );
});

test('the gate step runs before the dispatch, and the dispatch is conditional on its answer', () => {
  const list = steps();
  const gate = list.find((s) => (s.run ?? '').includes('cd-dispatch-gate.mjs'));
  const dispatch = list.find((s) => (s.run ?? '').includes('cd-deploy.yml/dispatches'));
  assert.ok(gate?.id, 'the gate step needs an `id:` for the dispatch step to read its output');
  assert.ok(dispatch, 'trigger-cd no longer dispatches cd-deploy');
  assert.ok(
    list.indexOf(gate) < list.indexOf(dispatch),
    'the dispatch runs before the gate decides — the gate is then decoration',
  );
  assert.match(
    String(dispatch.if ?? ''),
    new RegExp(`steps\\.${gate.id}\\.outputs\\.dispatch`),
    'the dispatch step is not gated on the gate\'s `dispatch` output, so it fires unconditionally — ' +
      'including for a superseded commit, which deploys a tip whose CI was never checked ' +
      '(the dispatch sends {"ref":"main"}, not this sha).',
  );
});

test('the checkout precedes the gate and fetches enough history to find the last deploy', () => {
  // The gate diffs `lastDeploy().commit..HEAD` to answer "is there anything to deploy". A shallow
  // clone cannot reach the promotion commit, which makes the answer null — safe (it dispatches), but
  // it silently disables the redundant-deploy skip on every single run.
  const list = steps();
  const checkout = list.find((s) => String(s.uses ?? '').startsWith('actions/checkout'));
  const gate = list.find((s) => (s.run ?? '').includes('cd-dispatch-gate.mjs'));
  assert.ok(checkout, 'trigger-cd does not check out the repository, so the gate script is absent');
  assert.ok(list.indexOf(checkout) < list.indexOf(gate), 'the checkout must precede the gate step');
  assert.equal(
    checkout.with?.['fetch-depth'],
    0,
    'the checkout is shallow, so `git diff <last promotion commit>..HEAD` cannot resolve its base ' +
      'and the nothing-to-deploy skip never fires',
  );
  assert.notEqual(
    checkout['continue-on-error'],
    true,
    'the checkout is marked continue-on-error. That was correct while it ran AFTER the dispatch ' +
      '(diagnostics must not manufacture a failure); it is wrong now that the gate depends on it — ' +
      'a failed checkout would silently skip the deploy decision.',
  );
});

test('the job\'s own steps are instrumented for the failure digest', () => {
  // Acceptance criterion 5. The incident's digest read `Failing step: _not reported_` and `no log
  // output was captured`, and the job's exemption gave the reason: its steps ran BEFORE any checkout,
  // so scripts/ci-log-step.sh did not exist on disk yet. The checkout now runs first because the gate
  // needs it, so the exemption's premise is gone and the marker must go with it.
  const jobStart = text.indexOf('\n  trigger-cd:');
  assert.ok(jobStart > 0, 'trigger-cd job header not found in the raw workflow text');
  const rest = text.slice(jobStart + 1);
  const nextJob = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const jobText = nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
  assert.doesNotMatch(
    jobText,
    /ci-log-step-exempt/,
    'trigger-cd still claims a ci-log-step exemption, but its steps now run after a checkout',
  );

  for (const step of steps()) {
    // The failure-digest step is the collector itself — wrapping it in the collector is circular.
    if (!step.run || String(step.run).includes('ci-failure-digest.mjs')) continue;
    assert.match(
      String(step.run).trimStart(),
      /^bash scripts\/ci-log-step\.sh /,
      `the step "${step.name ?? '(unnamed)'}" runs outside scripts/ci-log-step.sh, so its output is ` +
        'absent from the failure digest — the gap item #230 called out by name',
    );
  }
});
