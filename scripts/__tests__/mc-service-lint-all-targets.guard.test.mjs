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
