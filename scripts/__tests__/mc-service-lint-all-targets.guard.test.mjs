// Item #229 — the fast Rust gate must compile the code that TESTS mc-service, not just the library.
//
// WHAT WENT WRONG. `app-ci / mc-service-checks` is the fast Rust gate: clippy plus `cargo test --lib`,
// no Mongo, minutes rather than the ~35 of `app-e2e`. On PR #216 (reqwest 0.12 -> 0.13,
// 2026-08-22) it went GREEN on a change that made all three mc-service integration test binaries fail
// to compile — `RequestBuilder::form` became feature-gated and the ROPC helper in
// tests/integration/common/auth.rs calls it. Neither of the gate's two commands builds
// `tests/**`: clippy without `--all-targets` checks lib + bins only, and `--lib` is the library
// target's own unit tests. `cargo test -p mc-service --no-run` reproduced it locally in 15 seconds.
//
// WHY IT IS NOT MERELY SLOWER FEEDBACK. `Cargo.lock` is deliberately absent from the `changes` job's
// `app` filter, so on a Cargo-only pull request `app-e2e` — the only job that compiles those sources —
// does not run at all. Measured on PR #216 at c6defc2e, 2026-08-23: every required context green with
// `app-e2e` reporting `skipped (path-gated -> satisfied)`. An earlier revision of that same PR was
// caught only because it happened to carry unrelated JS lockfile changes from a `main` merge, which
// put it back inside the `app` filter — caught by coincidence, not by design. `--all-targets` on
// clippy is therefore the only thing in CI that compiles the integration harness on such a PR.
//
// WHY A TEST AND NOT A COMMENT. The justification in openwiki/projects/ci-cd-pipeline.md for excluding
// `Cargo.lock` from the `app` filter was a comment asserting a property the code did not have — "a bad
// Cargo floor already reds a tier that runs". It reds a tier that runs only while the flag below is
// present. Removing `--all-targets` would restore the exact green-on-broken state of PR #216, and no
// green tick could show it: this forge exposes no jobs/steps endpoint, and a clean compile and a
// never-attempted compile look identical from the outside.
//
// WHAT THIS DOES NOT ASSERT. That clippy is *correct*, only that it is pointed at every target. The
// coverage claim itself was mutation-checked against this branch by deleting the `form` call's helper
// from tests/integration/common/auth.rs: `pnpm nx lint mc-service` failed with E0599 and
// `pnpm nx test:unit mc-service` passed, which is the shape of the miss this pins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = JSON.parse(readFileSync(resolve(REPO_ROOT, 'backend/mc-service/project.json'), 'utf8'));
const WORKFLOW = parseYaml(readFileSync(resolve(REPO_ROOT, '.forgejo/workflows/app-ci.yml'), 'utf8'));
const CARGO_TOML = readFileSync(resolve(REPO_ROOT, 'backend/mc-service/Cargo.toml'), 'utf8');

/** Every `run:` script in a job, joined — steps are the unit CI executes, not a structure to walk. */
function jobRunScripts(jobName) {
  const job = WORKFLOW?.jobs?.[jobName];
  assert.ok(job, `app-ci.yml has no \`${jobName}\` job — every assertion about it would pass vacuously`);
  const steps = (job.steps ?? []).filter((s) => typeof s?.run === 'string');
  assert.ok(steps.length > 0, `\`${jobName}\` has no \`run:\` steps`);
  return steps.map((s) => s.run).join('\n');
}

function lintCommand() {
  const command = PROJECT?.targets?.lint?.options?.command;
  assert.equal(
    typeof command,
    'string',
    'mc-service has no `lint` target command — the flag assertion below would pass vacuously',
  );
  return command;
}

test('mc-service declares integration test targets, so --all-targets has sources to compile', () => {
  // Runs first and deliberately asserts something trivial. If the `[[test]]` entries or the source
  // tree were gone, `--all-targets` would compile nothing extra and every assertion below would be
  // true while covering nothing — which is precisely the failure mode this file exists to prevent.
  const declared = [...CARGO_TOML.matchAll(/^\s*name\s*=\s*"([a-z_]+_test)"/gm)].map((m) => m[1]);
  assert.ok(
    declared.length >= 3,
    `expected mc-service's Cargo.toml to declare its integration test binaries, found: ${declared.join(', ') || '(none)'}`,
  );
  const sources = readdirSync(resolve(REPO_ROOT, 'backend/mc-service/tests/integration'), {
    recursive: true,
  }).filter((f) => String(f).endsWith('.rs'));
  assert.ok(
    sources.length > 0,
    'backend/mc-service/tests/integration contains no .rs sources — nothing for the gate to compile',
  );
});

test('the lint target compiles ALL cargo targets, not just lib + bins', () => {
  const command = lintCommand();
  assert.match(
    command,
    /(^|\s)--all-targets(\s|$)/,
    'mc-service `lint` lost `--all-targets`: clippy then checks lib + bins only, and nothing in the ' +
      'fast gate compiles backend/mc-service/tests/** — the PR #216 green-on-broken state (item #229)',
  );
  // The flag must reach cargo, not clippy's own lint list: everything after the bare `--` is passed
  // through to the lint driver, where `--all-targets` is not a recognised option.
  const [cargoArgs] = command.split(' -- ');
  assert.match(
    cargoArgs,
    /--all-targets/,
    '`--all-targets` sits after the `--` separator, where it is a lint argument rather than a cargo one',
  );
});

test('the lint target still denies warnings, so a finding in test code fails the gate', () => {
  // `--all-targets` without `-D warnings` would compile the test sources and then report their
  // findings as warnings — a green job that has seen the breakage and said nothing.
  assert.match(lintCommand(), /--\s+-D\s+warnings/, 'mc-service `lint` no longer denies warnings');
});

test('mc-service-checks runs the lint target, so the flag is exercised on every pull request', () => {
  // The flag is only coverage if the job that runs on every PR invokes it. app-ci has NO top-level
  // `paths:` filter, so `mc-service-checks` runs on every PR including a Cargo-only one.
  assert.match(
    jobRunScripts('mc-service-checks'),
    /nx\s+lint\s+mc-service/,
    '`mc-service-checks` no longer invokes `nx lint mc-service` — the `--all-targets` coverage is unreachable',
  );
  assert.equal(
    WORKFLOW?.on?.pull_request ?? null,
    null,
    'app-ci grew a `pull_request:` filter — a Cargo-only PR could now skip mc-service-checks too',
  );
});

test('the compile check ADDS to the integration tier, it does not replace it', () => {
  // Acceptance criterion 4 of item #229. `--all-targets` proves the harness compiles; only app-e2e
  // proves it passes, against a replica-set Mongo.
  assert.equal(
    PROJECT?.targets?.['test:integration']?.options?.command,
    'node scripts/mc-service-integration-guard.mjs',
    'the mc-service `test:integration` target changed — the compile check does not replace running them',
  );
  assert.match(
    jobRunScripts('app-e2e'),
    /mc-service-integration-guard\.mjs/,
    '`app-e2e` no longer runs the mc-service integration guard',
  );
});

// ─── The `test` target must not disagree with the gate about threading ───────────────────────────
//
// Item #462's follow-on. `nx test:integration mc-service` — the ONLY invocation CI makes — runs the
// integration binaries through `scripts/mc-service-integration-guard.mjs`, which pins
// `--test-threads=1`. `nx test mc-service`, what a developer actually runs, used the
// `@monodon/rust:test` executor and therefore ran cargo at DEFAULT parallelism. The two tiers
// disagreed about the one setting that changes the result.
//
// That is not hypothetical. `logging_middleware_emits_structured_json` (item #462) failed ~2 runs in 3
// under parallelism and was green in CI for months, because CI never ran it that way. A tier that
// passes under one invocation and fails under another teaches the reader to ignore its result.
//
// MEASURED 2026-09-15/16, after item #462 was fixed, on a CLEAN MongoDB (no leaked test databases):
// the integration binaries at default parallelism failed **2 runs in 29**, always in
// `movies::large_collection_test` — either `create_indexes … index creation failed` or
// `create <movie> failed: MovieNotFound`, a read-your-own-writes miss on the insert/read-back in
// `MongoMovieRepository::create`. Serial is 180/180 and stable. So the gate stays serial, and the
// reconciliation is that `test` DELEGATES rather than carrying its own copy of the setting.
//
// The delegation is the point: a second literal `--test-threads` anywhere is a second thing to drift,
// and drift is how this started.

test('#462-followon: `test` delegates to test:unit + test:integration, and owns no threading of its own', () => {
  const proj = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'backend/mc-service/project.json'), 'utf8'),
  );
  const target = proj.targets.test;
  assert.ok(target, 'mc-service must keep a `test` target');

  const deps = target.dependsOn ?? [];
  assert.ok(
    deps.includes('test:unit') && deps.includes('test:integration'),
    `\`test\` must depend on both tiers so it cannot diverge from the gate; got ${JSON.stringify(deps)}`,
  );

  // Check what the target EXECUTES, not what it documents. An earlier version of this guard
  // stringified the whole target, so the `metadata.description` explaining "do not give this target
  // its own --test-threads" tripped the very rule it was describing. A guard that cannot tell a
  // setting from a sentence about that setting will eventually be silenced rather than fixed.
  const executed = [target.options?.command, ...(target.options?.commands ?? []), ...(target.options?.args ?? [])]
    .filter(Boolean)
    .join(' ');
  assert.doesNotMatch(
    executed,
    /--test-threads/,
    'the `test` target must NOT carry its own --test-threads — the guard owns that decision, and a ' +
      `second copy is a second thing to drift; got: ${executed}`,
  );
  assert.notEqual(
    target.executor,
    '@monodon/rust:test',
    'the @monodon/rust:test executor runs cargo at default parallelism, which is exactly the ' +
      'divergence this pins',
  );
});

test('#462-followon: the threading decision exists in exactly ONE place in the repo', () => {
  // If this count ever exceeds one, the two tiers can disagree again without anyone noticing.
  const guard = readFileSync(resolve(REPO_ROOT, 'scripts/mc-service-integration-guard.mjs'), 'utf8');
  const inGuard = (guard.match(/cargoArgs\.push\([^)]*--test-threads=1/g) ?? []).length;
  assert.equal(inGuard, 1, 'the guard must pin the thread count exactly once');

  // Again: executed surface only, across every target — prose may name the flag, commands may not.
  const proj = JSON.parse(readFileSync(resolve(REPO_ROOT, 'backend/mc-service/project.json'), 'utf8'));
  const offenders = Object.entries(proj.targets ?? {})
    .filter(([, t]) =>
      [t.options?.command, ...(t.options?.commands ?? []), ...(t.options?.args ?? [])]
        .filter(Boolean)
        .some((c) => String(c).includes('--test-threads')),
    )
    .map(([name]) => name);
  assert.deepEqual(
    offenders,
    [],
    `project.json must not pin a thread count in any target — it would be a second, drifting source ` +
      `of truth; offending target(s): ${offenders.join(', ')}`,
  );
});

test('#462-followon: the serial pin carries its MEASURED reason, not just a value', () => {
  // It sat unexplained from the initial commit (2026-05-23) until item #462's follow-on measured it.
  // A setting nobody can justify is a setting nobody dares change, and this one hid a real flake.
  const guard = readFileSync(resolve(REPO_ROOT, 'scripts/mc-service-integration-guard.mjs'), 'utf8');
  const at = guard.indexOf('--test-threads=1');
  const preamble = guard.slice(Math.max(0, at - 2500), at);
  assert.match(preamble, /large_collection_test/,
    'the comment must name where parallel execution actually fails');
  assert.match(preamble, /2 runs in 29|2 failures in 29|2\/29/,
    'the comment must carry the measured failure rate, so the next person can re-measure it');
});

// ─── Item #954 — a Cargo-only change RUNS the integration tier, it does not just compile it ───────
//
// `--all-targets` (above) proves a dependency bump still BUILDS the test harness. It cannot prove the
// dependency still BEHAVES. PR #946 moved axum-keycloak-auth 0.8.3 -> 0.8.4 (a non-JWT bearer now
// answers 401, not 400): every required context green, app-e2e skipped, and the bump reached a
// production promotion before `main` first ran the tier and failed. So a change to the root Cargo
// files now selects `mc-service-checks-integration`, which runs the same step app-e2e runs.
//
// Mutation-checked: dropping `Cargo.lock` from the `cargo` filter, inverting the `app != 'true'`
// arm, renaming the job out of the `mc-service-checks*` glob, editing one `-e` of the copied step,
// and removing the job from trigger-cd's `needs` each fail a test below.

/** The `changes` job's filter sets — a YAML document embedded as a STRING, so it needs a 2nd parse. */
function filterSets() {
  const step = (WORKFLOW?.jobs?.changes?.steps ?? []).find((s) => typeof s?.with?.filters === 'string');
  assert.ok(step, 'the changes job has no dorny/paths-filter step with a `filters` input');
  return parseYaml(step.with.filters);
}

/** The single step whose `run` invokes the integration guard, in `jobName`. */
function integrationStep(jobName) {
  const steps = (WORKFLOW?.jobs?.[jobName]?.steps ?? []).filter(
    (s) => typeof s?.run === 'string' && s.run.includes('mc-service-integration-guard.mjs'),
  );
  assert.equal(steps.length, 1, `\`${jobName}\` should run the integration guard in exactly one step`);
  return steps[0];
}

const IT_JOB = 'mc-service-checks-integration';

test('#954: the `cargo` filter selects the root Cargo files, and `changes` exports it', () => {
  const { cargo, app } = filterSets();
  assert.ok(Array.isArray(cargo) && cargo.length > 0, 'the `cargo` filter is missing or empty');
  for (const path of ['Cargo.lock', 'rust-toolchain.toml']) {
    assert.ok(cargo.includes(path), `the \`cargo\` filter does not select ${path}`);
  }
  assert.ok(
    cargo.includes('Cargo.toml') || cargo.includes('**/Cargo.toml'),
    'the `cargo` filter does not select the workspace Cargo.toml',
  );
  assert.match(
    String(WORKFLOW?.jobs?.changes?.outputs?.cargo ?? ''),
    /steps\.filter\.outputs\.cargo/,
    '`changes` does not export the `cargo` output — the integration job would gate on an empty string',
  );
  // The exclusion itself stands: a Cargo change buys the ~5-min tier, not the ~23-min app-e2e.
  assert.ok(!app.includes('Cargo.lock'), 'Cargo.lock moved into `app` — the comment above `changes` explains why not');
});

test('#954: the integration job runs on a Cargo change only when app-e2e does not', () => {
  const job = WORKFLOW?.jobs?.[IT_JOB];
  assert.ok(job, `app-ci has no \`${IT_JOB}\` job`);
  const gate = String(job.if ?? '');
  assert.match(gate, /needs\.changes\.outputs\.cargo\s*==\s*'true'/, 'the job no longer gates on the `cargo` filter');
  assert.match(
    gate,
    /needs\.changes\.outputs\.app\s*!=\s*'true'/,
    'the job no longer defers to app-e2e — both would run the tier over the same containers on one host',
  );
  assert.ok(job.needs?.includes('changes'), 'the job does not need `changes`, so its outputs are always empty');
  assert.ok(job.needs?.includes('mc-service-checks'), 'the job no longer waits for the fast compile gate');
});

test('#954: the job name sits under the branch-protection glob, so its failure blocks the merge', async () => {
  const { REQUIRED_CONTEXT_GLOBS } = await import('../ci-status.mjs');
  const glob = 'app-ci / mc-service-checks*';
  assert.ok(REQUIRED_CONTEXT_GLOBS.includes(glob), `\`${glob}\` is no longer a required context glob`);
  assert.ok(`app-ci / ${IT_JOB} (pull_request)`.startsWith(glob.slice(0, -1)), `\`${IT_JOB}\` is outside \`${glob}\``);
});

test('#954: the integration step is IDENTICAL to app-e2e\'s, step id and env included', () => {
  const ours = integrationStep(IT_JOB);
  const theirs = integrationStep('app-e2e');
  assert.equal(ours.run, theirs.run, 'the two integration steps diverged — one tier, two definitions');
  assert.match(ours.run, /ci-log-step\.sh mc-service-integration\b/, 'the step id changed, so it lost its calibrated ceiling');
});

test('#954: trigger-cd needs the integration job and refuses to deploy on its failure', () => {
  const cd = WORKFLOW?.jobs?.['trigger-cd'];
  assert.ok(cd?.needs?.includes(IT_JOB), `trigger-cd does not need \`${IT_JOB}\` — a red tier would still deploy`);
  assert.match(
    String(cd.if ?? ''),
    new RegExp(`needs\\.${IT_JOB}\\.result == 'success' \\|\\| needs\\.${IT_JOB}\\.result == 'skipped'`),
    'trigger-cd does not gate on the integration job\'s result',
  );
});
