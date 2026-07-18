#!/usr/bin/env node
/**
 * mc-service integration test runner + no-false-green guard (feature 041, T005).
 *
 * This is the command behind `pnpm nx test:integration mc-service`. It runs the Rust integration
 * test BINARIES (each `backend/mc-service/tests/*.rs` compiles to one binary) and enforces the
 * cross-language skip-escalation convention for the cargo runner
 * (specs/041-integration-test-ci-enforcement/contracts/skip-escalation-convention.md):
 *
 *   Rust has no "skip" primitive — a missing dependency already panics via `.expect()`/`.unwrap()`
 *   in the test body, so a down Mongo/Keycloak FAILS the run (never skips). The remaining
 *   false-green vectors are (a) an UNDOCUMENTED `#[ignore]` silently disabling a test and (b) a
 *   wholesale-disabled suite that executes zero tests yet still exits 0. This guard closes both:
 *
 *     1. FORBID BARE `#[ignore]` (no reason string) anywhere under backend/mc-service/tests/. A
 *        documented `#[ignore = "reason"]` is allowed — the suite legitimately ignores ~24
 *        full-stack HTTP tests ("requires Keycloak JWKS timing; verified in E2E") and a few
 *        process-global-conflict / wrong-layer tests. Silencing a test without a documented reason
 *        is what this bans. (Deviates from the planning contract's blanket ban — reconciled in
 *        specs/041-…/contracts/skip-escalation-convention.md, because documented ignores pre-exist.)
 *     2. Run each integration binary and require it EXECUTED at least one test (passed+failed > 0),
 *        and that every discovered binary produced a `test result:` line → an all-ignored /
 *        zero-executed run (e.g. someone `#[ignore]`s a whole binary) is treated as FAILURE, not green.
 *
 * Passthrough: extra args after `--` (e.g. `pnpm nx test:integration mc-service -- --test-threads 4`)
 * are forwarded to cargo AFTER the libtest `--` separator; when passthrough test-filter args are
 * present we DELEGATE to cargo semantics and skip the executed-count assertion (a single-test dev
 * run legitimately executes a subset) but STILL forbid `#[ignore]`.
 *
 * `--selftest` runs the parser against canned libtest output and exits 0 (used by the guardrails
 * self-check convention).
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST = 'backend/mc-service/Cargo.toml';
// The integration tests live under tests/integration/ (a subdir layout — the binary entry points
// are declared as [[test]] targets in Cargo.toml, submodules compile into them).
const TESTS_DIR = 'backend/mc-service/tests/integration';

/** Recursively collect every *.rs file under a directory. */
function rsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...rsFiles(p));
    else if (entry.endsWith('.rs')) out.push(p);
  }
  return out;
}

/** The integration test BINARY names, read from the Cargo.toml [[test]] target declarations. */
function integrationBinaries() {
  const toml = readFileSync(MANIFEST, 'utf-8');
  const names = [];
  // Each [[test]] block whose path points into tests/integration/ is one integration binary.
  const re = /\[\[test\]\][^[]*?name\s*=\s*"([^"]+)"[^[]*?path\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(toml)) !== null) {
    if (m[2].replace(/\\/g, '/').includes('tests/integration/')) names.push(m[1]);
  }
  return names.sort();
}

/**
 * Fail on a BARE `#[ignore]` (no `= "reason"`) — an undocumented silence. A documented
 * `#[ignore = "reason"]` is allowed (see the module header). Only real attribute lines are
 * inspected; `///` doc-comments that merely mention `#[ignore]` are skipped.
 */
export function findBareIgnores(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) return; // doc/line comment, not an attribute
    // A bare ignore attribute: `#[ignore]` / `#[ ignore ]` but NOT `#[ignore = "..."]`.
    if (/^#\s*\[\s*ignore\s*\]/.test(trimmed)) hits.push(i + 1);
  });
  return hits;
}

function assertNoBareIgnore() {
  const offenders = [];
  for (const file of rsFiles(TESTS_DIR)) {
    const lines = findBareIgnores(readFileSync(file, 'utf-8'));
    if (lines.length) offenders.push(`${file}:${lines.join(',')}`);
  }
  if (offenders.length) {
    console.error(
      `\n[mc-service-integration-guard] FAIL: a BARE #[ignore] silences a test with no reason. ` +
        `Give it a documented reason (#[ignore = "why; where it IS covered"]) or remove it:\n  - ` +
        offenders.join('\n  - ') +
        '\n',
    );
    process.exit(1);
  }
}

/**
 * Parse libtest summary lines. Each test binary prints exactly one:
 *   `test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; ...`
 * Returns [{ passed, failed, ignored }] in order.
 */
export function parseResults(stdout) {
  const results = [];
  const re = /test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/g;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    results.push({ passed: Number(m[1]), failed: Number(m[2]), ignored: Number(m[3]) });
  }
  return results;
}

function selftest() {
  const sample = [
    'running 3 tests',
    'test a ... ok',
    'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.4s',
    '',
    'running 1 test',
    'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.1s',
  ].join('\n');
  const parsed = parseResults(sample);
  const executed = parsed.reduce((n, r) => n + r.passed + r.failed, 0);
  const allZero = parseResults('test result: ok. 0 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out;');
  // Bare-ignore detection: only a real `#[ignore]` attribute line (not a doc comment) is flagged.
  const bare = findBareIgnores('#[ignore]\n#[ignore = "ok"]\n/// mentions #[ignore]\n#[tokio::test]');
  const ok =
    parsed.length === 2 &&
    executed === 4 &&
    allZero.length === 1 &&
    allZero[0].passed + allZero[0].failed === 0 &&
    bare.length === 1 &&
    bare[0] === 1;
  if (!ok) {
    console.error('[mc-service-integration-guard] selftest FAILED', { parsed, executed, allZero, bare });
    process.exit(1);
  }
  console.log('[mc-service-integration-guard] selftest OK');
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  // A bare/undocumented `#[ignore]` is forbidden regardless of how the suite is invoked.
  assertNoBareIgnore();

  const binaries = integrationBinaries();
  if (binaries.length === 0) {
    console.error('[mc-service-integration-guard] FAIL: no integration test binaries under ' + TESTS_DIR);
    process.exit(1);
  }

  // Passthrough args (a `-- <extra>` from Nx). Their presence means a targeted dev run → delegate.
  const passthrough = argv;
  const targeted = passthrough.length > 0;

  const cargoArgs = ['test', '--manifest-path', MANIFEST];
  // Run the integration binaries explicitly so the parsed `test result:` lines are integration-only
  // (`--tests` would also run the crate's inline unit tests, which have their own `test:unit` target).
  for (const b of binaries) cargoArgs.push('--test', b);
  cargoArgs.push('--', '--test-threads=1', ...passthrough);

  console.log('[mc-service-integration-guard] cargo ' + cargoArgs.join(' '));
  const child = spawn('cargo', cargoArgs, { shell: false });

  let captured = '';
  child.stdout.on('data', (d) => {
    const s = d.toString();
    captured += s;
    process.stdout.write(s);
  });
  child.stderr.on('data', (d) => process.stderr.write(d));

  child.on('error', (err) => {
    console.error('[mc-service-integration-guard] failed to spawn cargo: ' + err.message);
    process.exit(1);
  });

  child.on('close', (code) => {
    if (code !== 0) process.exit(code); // tests failed / panicked (e.g. Mongo down) — already red.

    if (targeted) {
      // A targeted single-test/dev run legitimately executes a subset — no count assertion.
      process.exit(0);
    }

    const results = parseResults(captured);
    const executed = results.reduce((n, r) => n + r.passed + r.failed, 0);
    const anyZeroBinary = results.some((r) => r.passed + r.failed === 0);

    if (results.length < binaries.length || executed === 0 || anyZeroBinary) {
      console.error(
        `\n[mc-service-integration-guard] FAIL (no-false-green): expected ${binaries.length} ` +
          `integration binaries to each EXECUTE ≥1 test, but saw ${results.length} result line(s) ` +
          `totalling ${executed} executed test(s). A zero-executed / all-ignored run is treated as ` +
          `FAILURE, not green (MCM_REQUIRE_LIVE_STACK semantics for the cargo runner).\n`,
      );
      process.exit(1);
    }
    console.log(
      `[mc-service-integration-guard] OK: ${results.length} integration binaries executed ${executed} tests.`,
    );
    process.exit(0);
  });
}

main();
