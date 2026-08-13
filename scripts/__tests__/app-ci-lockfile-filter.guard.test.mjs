// Feature 058 (item #186) — the app-ci change-detection wiring, asserted statically.
//
// WHY A TEST AND NOT A COMMENT. Every fact below was, at some point, asserted by a comment in
// app-ci.yml and was either wrong or became wrong:
//
//   * `pnpm-lock.yaml` sits in the `push:` paths filter with the comment "a lockfile bump changes
//     transitive deps -> rebuild the affected images", and is ABSENT from the `changes` job's `app`
//     filter that gates app-e2e on a PULL REQUEST. So the risk was acknowledged for push and denied
//     for pull_request. Measured: app-e2e reported `skipped` on both PR #185 and PR #187, and PR
//     #185's only evidence that its two raised floors did not break the app was a LOCAL run someone
//     remembered to do.
//
//   * `mobile` carried the comment "It is a STRICT SUBSET of `app`". It was not. Two entries
//     (scripts/ci-mobile-agent-flows.sh, scripts/maestro-run.sh) were in `mobile` and not in `app`,
//     which makes them INERT: `mobile` only gates STEPS INSIDE app-e2e, and app-e2e itself requires
//     app == 'true'. A pull request touching only the Maestro runner therefore set mobile=true,
//     app=false, skipped the whole job, and ran no mobile flow at all. Found by writing this test.
//
// THE VERIFICATION THIS REPLACES. The intended check was to read a run's step list and see which
// jobs ran. This Forgejo build exposes no jobs/steps endpoint (`/actions/runs/<id>/jobs` is 404) and
// a SUCCESSFUL run publishes no failure digest, so a green tick cannot distinguish "the filter
// matched" from "the filter was deleted and the job ran for another reason". What IS observable is a
// job's CONCLUSION (`skipped` vs a real result), which is how #186 was measured — so the top-level
// claim is checked on a real pull request (spec SC-001) and the wiring is pinned here.
//
// It asserts the WIRING, not the runner's `if:` evaluation. That residual is small and named.
//
// Assertion 6 is the load-bearing one: the other five are inert the moment app-e2e stops consuming
// `changes.outputs.app`. Each of the six is mutation-tested (tasks.md T003) — a wiring test that has
// never been shown to fail is indistinguishable from one that asserts nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = resolve(REPO_ROOT, '.forgejo/workflows/app-ci.yml');

const workflow = parseYaml(readFileSync(WORKFLOW, 'utf8'));

/** The two files whose classification this feature exists to fix. */
const DEPENDENCY_FILES = ['pnpm-lock.yaml', 'pnpm-workspace.yaml'];

/**
 * The `dorny/paths-filter` step's `filters` input is a YAML document embedded as a STRING inside
 * `with:`, so it needs a second parse. Indexing into the outer parse yields `undefined`, and an
 * assertion against `undefined` passes vacuously — which is the exact failure mode this file exists
 * to prevent. Hence the non-empty assertions in the first test, which run before anything else.
 */
function filterSets() {
  const steps = workflow?.jobs?.changes?.steps ?? [];
  const step = steps.find((s) => typeof s?.with?.filters === 'string');
  assert.ok(step, 'the changes job has no dorny/paths-filter step with a `filters` input');
  const parsed = parseYaml(step.with.filters);
  assert.ok(parsed && typeof parsed === 'object', 'the `filters` input did not parse as a YAML mapping');
  return parsed;
}

/** `on:` is a plain string key under the YAML 1.2 core schema the `yaml` package uses by default. */
function pushPaths() {
  return workflow?.on?.push?.paths ?? [];
}

test('the change filters parse, and both filter sets are non-empty', () => {
  // Runs first and deliberately asserts something trivial: every other test in this file reads these
  // two sets, and a test that silently reads an empty set reports success while checking nothing.
  const filters = filterSets();
  assert.ok(
    Array.isArray(filters.app) && filters.app.length > 0,
    'the `app` filter is missing or empty — every other assertion in this file would pass vacuously',
  );
  assert.ok(
    Array.isArray(filters.mobile) && filters.mobile.length > 0,
    'the `mobile` filter is missing or empty — the subset and exclusion assertions would pass vacuously',
  );
  assert.ok(pushPaths().length > 0, 'the push paths filter is missing or empty');
});

test('a lockfile / workspace-manifest change selects the app filter that gates app-e2e', () => {
  // FR-001, FR-002. This is item #186 itself: these are JS-toolchain transitives, so breakage
  // surfaces at BUILD time and `nx test` passes straight over a broken floor (feature 057, FR-013).
  // The light jobs that do run on a lockfile PR are exactly the ones that cannot see it.
  const { app } = filterSets();
  for (const file of DEPENDENCY_FILES) {
    assert.ok(
      app.includes(file),
      `the \`app\` filter does not select ${file}, so a pull request changing only that file skips ` +
        'app-e2e — the only tier that catches a bad transitive floor. Renovate now opens these ' +
        'pull requests weekly (feature 058 enables lockFileMaintenance), so this is not hypothetical.',
    );
  }
});

test('a lockfile / workspace-manifest change does NOT select the mobile emulator half', () => {
  // FR-003. The accepted cost of #186 is the ~23-minute web+integration half, NOT the ~35-minute
  // emulator half. A lockfile change is a web/bundle risk; the `mobile-e2e` label remains the escape
  // hatch when a specific refresh warrants the emulator.
  const { mobile } = filterSets();
  for (const file of DEPENDENCY_FILES) {
    assert.ok(
      !mobile.includes(file),
      `the \`mobile\` filter selects ${file}, which adds the ~35-minute emulator half to every ` +
        'dependency pull request on a single CI runner. That cost was explicitly not accepted.',
    );
  }
});

test('the mobile filter is a strict subset of the app filter', () => {
  // FR-004. `mobile` gates STEPS INSIDE app-e2e, and app-e2e itself requires app == 'true'. A path
  // in `mobile` but not in `app` is therefore INERT — it sets mobile=true, app=false, and the whole
  // job skips, so the steps it was meant to select never run.
  //
  // This is not hypothetical either: scripts/ci-mobile-agent-flows.sh and scripts/maestro-run.sh
  // were in exactly that state until feature 058, so changing the Maestro runner ran no mobile flow.
  const { app, mobile } = filterSets();
  const appSet = new Set(app);
  const inert = mobile.filter((p) => !appSet.has(p));
  assert.deepEqual(
    inert,
    [],
    `these paths are in \`mobile\` but not \`app\`: ${inert.join(', ')}.\n` +
      '  `mobile` only gates steps inside app-e2e, and app-e2e runs only when `app` is true, so a ' +
      'pull request touching one of these skips the entire job and runs no mobile flow. Add them to ' +
      '`app` as well, or remove them from `mobile` — a filter entry that can never fire is worse ' +
      'than none, because it reads as coverage.',
  );
});

test('the pull-request filter and the push paths filter agree about dependency files', () => {
  // FR-005. Item #186's third acceptance criterion: the two filters must either agree about
  // lockfiles or the file must record why they deliberately differ.
  //
  // Cargo.lock is the recorded deliberate difference and is NOT asserted here: mc-service-checks
  // runs clippy and the unit tier on every pull request and both COMPILE the crate, so a bad Cargo
  // floor already fails a tier that runs. The 057 FR-013 argument is specific to JS transitives.
  const paths = pushPaths();
  for (const file of DEPENDENCY_FILES) {
    assert.ok(
      paths.includes(file),
      `the push paths filter does not select ${file}, so the pull-request filter and the push ` +
        'filter disagree about whether a dependency change is app-affecting. A merge to main would ' +
        'not rebuild the affected images for a change the pull request did test.',
    );
  }
});

test('app-e2e is still gated on the change filter it consumes', () => {
  // FR-006, and the assertion that carries the other five. If app-e2e stops reading
  // changes.outputs.app, every filter entry above becomes decoration: the job either always runs or
  // never does, and nothing in a green tick would reveal which.
  const gate = workflow?.jobs?.['app-e2e']?.if;
  assert.ok(
    typeof gate === 'string' && gate.includes('needs.changes.outputs.app'),
    'app-e2e no longer gates on `needs.changes.outputs.app`. Every path added to the `app` filter ' +
      'is now decoration — the job runs (or does not) regardless of what changed, and no CI result ' +
      'distinguishes the two. If the gating genuinely moved, move this assertion with it.',
  );
  assert.ok(
    (workflow?.jobs?.['app-e2e']?.needs ?? []).includes('changes'),
    'app-e2e does not declare `needs: changes`, so `needs.changes.outputs.app` is always empty and ' +
      'the gate silently evaluates false — the suite would never run.',
  );
});
