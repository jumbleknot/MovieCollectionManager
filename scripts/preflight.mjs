#!/usr/bin/env node
// Local pre-push preflight — run what CI runs, minus the parts that need the CI runner.
//
// WHY: CI wall-clock is the scarce resource here. There is ONE `kvm` runner, `app-e2e` takes ~35
// minutes, and a stack of PRs serialises behind it — so a red push for a reason that was knowable
// offline is expensive out of all proportion to the mistake. Measured 2026-07-26: a Node pin below
// pnpm's `engines` floor cost roughly an hour of queue-plus-run to discover, and it was a static
// fact in two files the whole time.
//
// This runs every cheap, deterministic check in one command so it stops being discipline-dependent:
// the guardrail gates, the script unit tests, then lint/typecheck/unit for the app.
//
// NOT run here (deliberately): app-e2e, dast, the integration tiers, and the SAST/SCA scan. Those
// need a live stack, an emulator, or minutes of scanning — CI owns them. Preflight is about making
// the FAST failures fast, not about reproducing CI.
//
// Usage:
//   pnpm nx preflight infrastructure-as-code     # the sanctioned entry point
//   node scripts/preflight.mjs [--gates-only]    # direct; --gates-only skips lint/typecheck/unit
//
// Exit codes: 0 all passed · 1 something failed (every check runs; failures are summarised at the
// end rather than aborting on the first, so one run tells you everything that is wrong).

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Gate scripts that support `--selftest`, run selftest-then-scan exactly as guardrails/naming does. */
const GATES_WITH_SELFTEST = [
  'check-no-inline-secrets',
  'check-komodo-sync',
  'check-topology-scrub',
  'check-no-argv-secrets',
  'check-prod-ci-port-collision',
  'check-prod-restart-policy',
  'check-ci-digest-coverage',
  'check-toolchain-consistency',
  'check-override-consistency',
  'check-realm-consistency',
  'secret-scan',
];

/** Gates invoked plain (no selftest, or a non-default argument shape). */
const PLAIN_GATES = [
  ['check-resource-naming', ['--section=all']],
];

const results = [];

function run(label, cmd, args, opts = {}) {
  process.stdout.write(`▶ ${label}\n`);
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe', ...opts });
  const ok = r.status === 0;
  results.push({ label, ok, status: r.status });
  if (!ok) {
    // Only failures print their output — a green preflight should be quiet enough to actually read.
    process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}\n`);
  }
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` (exit ${r.status})`}\n`);
  return ok;
}

const gatesOnly = process.argv.includes('--gates-only');

process.stdout.write('── preflight: guardrail gates ──────────────────────────────────────\n');
for (const g of GATES_WITH_SELFTEST) {
  run(`${g} --selftest`, 'node', [`scripts/${g}.mjs`, '--selftest']);
  run(g, 'node', [`scripts/${g}.mjs`]);
}
for (const [g, args] of PLAIN_GATES) run(g, 'node', [`scripts/${g}.mjs`, ...args]);

process.stdout.write('\n── preflight: script unit tests ────────────────────────────────────\n');
// Enumerate explicitly rather than passing the directory: CI runs `node --test
// scripts/__tests__/*.test.mjs` with the SHELL expanding the glob, and spawnSync does no expansion.
// Handing `node --test` the bare directory picks up non-test files and fails — matching CI's file
// set is the point, so the glob is resolved here instead.
const testFiles = readdirSync(join(REPO_ROOT, 'scripts', '__tests__'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join('scripts', '__tests__', f));
run(`scripts/__tests__ (${testFiles.length} files)`, 'node', ['--test', ...testFiles]);

if (!gatesOnly) {
  process.stdout.write('\n── preflight: app lint / typecheck / unit ──────────────────────────\n');
  for (const target of ['lint', 'typecheck', 'test']) {
    run(`nx ${target} mcm-app`, 'pnpm', ['nx', target, 'mcm-app']);
  }
}

const failed = results.filter((r) => !r.ok);
process.stdout.write('\n───────────────────────────────────────────────────────────────────\n');
if (failed.length) {
  process.stdout.write(`✗ preflight FAILED — ${failed.length} of ${results.length} check(s):\n`);
  for (const f of failed) process.stdout.write(`    ${f.label} (exit ${f.status})\n`);
  process.stdout.write('\nFix these before pushing — CI would spend a runner slot rediscovering them.\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`✓ preflight passed — ${results.length} check(s).\n`);
  process.stdout.write('  NOT covered here (CI owns them): app-e2e, dast, integration tiers, SAST/SCA scan.\n');
}
