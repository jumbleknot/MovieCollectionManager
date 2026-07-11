// T019 / T025 — SAST/SCA gate (scripts/check-sast-findings.mjs) — feature 033.
// Contract: specs/033-sast-semgrep/contracts/check-sast-findings.cli.md.
//
// Feeds synthetic normalized findings.json reports through the gate CLI as a subprocess and asserts
// exit codes (mirrors check-dast-findings.test.mjs):
//   (a) un-allowlisted blocking High → exit 1, finding named.
//   (b) same finding allowlisted → exit 0.
//   (c) High with scope: dev (blocking:false) → exit 0 (warned, not failed).
//   (d) clean report (no blocking) → exit 0.
//   (e) allowlist entry with blank justification → exit 2 (GateError).
//   (f) allowlist entry with a PAST expiry does NOT suppress → exit 1; future/absent → exit 0 (US3).
//   --selftest → exit 0 ; unparseable report → exit 2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-sast-findings.mjs');

function finding(over = {}) {
  return {
    scanner: 'semgrep', kind: 'sast', id: 'mcm-no-token-logging',
    title: 'Raw token logged', location: 'src/bff-server/auth.ts:42',
    ecosystem: null, nativeSeverity: 'ERROR', severity: 'High', scope: null,
    blocking: true, fixAvailable: null, ...over,
  };
}

function report(findings) {
  return { schemaVersion: 1, generatedAtScope: 'full', scanners: [], findings };
}

function runGate(reportObj, allowlistYaml) {
  const dir = mkdtempSync(join(tmpdir(), 'sast-gate-'));
  try {
    const reportPath = join(dir, 'findings.json');
    writeFileSync(reportPath, typeof reportObj === 'string' ? reportObj : JSON.stringify(reportObj));
    const args = ['--report', reportPath];
    if (allowlistYaml !== undefined) {
      const alPath = join(dir, 'allowlist.yaml');
      writeFileSync(alPath, allowlistYaml);
      args.push('--allowlist', alPath);
    }
    const r = spawnSync('node', [GATE, ...args], { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (a) un-allowlisted blocking High → exit 1
test('(a) un-allowlisted blocking High fails the gate (exit 1) and names the finding', () => {
  const { code, out } = runGate(report([finding()]), '[]\n');
  assert.equal(code, 1);
  assert.match(out, /mcm-no-token-logging/);
});

// (b) same finding allowlisted → exit 0
const MATCH_ALLOW = `
- scanner: "semgrep"
  id: "mcm-no-token-logging"
  locationPattern: "src/bff-server/auth\\\\.ts:.*"
  justification: "False positive: logs a request id, not a token (triaged)."
  addedBy: "steve"
`;
test('(b) an allowlisted blocking High passes the gate (exit 0)', () => {
  const { code } = runGate(report([finding()]), MATCH_ALLOW);
  assert.equal(code, 0);
});

test('(b2) allowlisted finding stays visible in the printed report (FR-010)', () => {
  const { out } = runGate(report([finding()]), MATCH_ALLOW);
  assert.match(out, /mcm-no-token-logging/, 'suppressed finding must still be shown, not hidden');
});

// (c) High but scope:dev (blocking:false) → exit 0 (warned)
test('(c) a High dev-scope (non-blocking) SCA finding does not fail the gate (exit 0)', () => {
  const dev = finding({ scanner: 'pnpm-audit', kind: 'sca', id: 'GHSA-x', location: 'esbuild@0.1.0', ecosystem: 'npm', scope: 'dev', blocking: false });
  const { code } = runGate(report([dev]), '[]\n');
  assert.equal(code, 0);
});

// (d) clean report → exit 0
test('(d) a clean report (no blocking findings) passes (exit 0)', () => {
  const { code } = runGate(report([]), '[]\n');
  assert.equal(code, 0);
});

// (e) blank justification → exit 2
test('(e) an allowlist entry with a blank justification is a gate error (exit 2)', () => {
  const bad = `
- scanner: "semgrep"
  id: "mcm-no-token-logging"
  locationPattern: ".*"
  justification: ""
  addedBy: "steve"
`;
  const { code } = runGate(report([finding()]), bad);
  assert.equal(code, 2);
});

test('(e2) an allowlist entry with an invalid regex is a gate error (exit 2)', () => {
  const bad = `
- scanner: "semgrep"
  id: "mcm-no-token-logging"
  locationPattern: "([unclosed"
  justification: "x"
  addedBy: "steve"
`;
  const { code } = runGate(report([finding()]), bad);
  assert.equal(code, 2);
});

// (f) expiry (US3)
test('(f) an allowlist entry with a PAST expiry does not suppress (exit 1)', () => {
  const expired = MATCH_ALLOW.trimEnd() + '\n  expiry: "2000-01-01"\n';
  const { code } = runGate(report([finding()]), expired);
  assert.equal(code, 1, 'a past-expiry entry must stop suppressing → the finding blocks again');
});

test('(f2) an allowlist entry with a FUTURE expiry still suppresses (exit 0)', () => {
  const future = MATCH_ALLOW.trimEnd() + '\n  expiry: "2999-01-01"\n';
  const { code } = runGate(report([finding()]), future);
  assert.equal(code, 0);
});

// different un-allowlisted blocking finding still fails despite an allowlist
test('a blocking finding not covered by the allowlist still fails (exit 1)', () => {
  const other = finding({ id: 'mcm-auth-before-authz', location: 'src/bff-server/other.ts:9' });
  const { code, out } = runGate(report([other]), MATCH_ALLOW);
  assert.equal(code, 1);
  assert.match(out, /mcm-auth-before-authz/);
});

// runtime SCA High blocks
test('a runtime-scope SCA High blocks (exit 1)', () => {
  const rt = finding({ scanner: 'cargo-audit', kind: 'sca', id: 'RUSTSEC-1', location: 'foo@1.0', ecosystem: 'cargo', scope: 'runtime', nativeSeverity: 'unscored' });
  const { code } = runGate(report([rt]), '[]\n');
  assert.equal(code, 1);
});

// --selftest
test('--selftest proves the gate paths (exit 0)', () => {
  const r = spawnSync('node', [GATE, '--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
});

// unparseable report → exit 2
test('an unparseable report is a gate error (exit 2)', () => {
  const { code } = runGate('{ not json', '[]\n');
  assert.equal(code, 2);
});
