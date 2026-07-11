// T005 / T018 — SAST/SCA orchestrator normalization guard (scripts/sast-scan.mjs) — feature 033.
// Contract: specs/033-sast-semgrep/contracts/sast-scan.cli.md + data-model.md.
//
// Unit-level tests over the orchestrator's PURE exported functions (no scanner subprocesses):
//   - severity normalization applies severity-map.yaml; an unmapped native value fails fast.
//   - `blocking` is derived per data-model: severity∈{High,Critical} AND (kind==sast OR scope==runtime).
//   - SCA scope classification (runtime vs dev) from the ecosystem runtime dep-set; unknown→runtime.
//   - a missing toolchain fails fast (assertToolchain throws, naming the scanner).
//   - a built findings report validates against contracts/findings.schema.json (ajv).
//   - the CLI exits non-zero on bad arguments (process-level exit-code wiring).
//
// RED until scripts/sast-scan.mjs exists and exports these; GREEN at T018.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv/dist/2020.js';

import {
  loadSeverityMap,
  normalizeSeverity,
  deriveBlocking,
  classifyScope,
  assertToolchain,
  buildFindingsReport,
} from '../sast-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const ORCH = resolve(REPO_ROOT, 'scripts', 'sast-scan.mjs');
const SCHEMA = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'specs/033-sast-semgrep/contracts/findings.schema.json'), 'utf8'),
);

const MAP = loadSeverityMap(); // default: security/sast/severity-map.yaml

// ── Severity normalization (research R4) ─────────────────────────────────────
test('normalizeSeverity applies severity-map.yaml for each scanner', () => {
  assert.equal(normalizeSeverity('semgrep', 'ERROR', MAP), 'High');
  assert.equal(normalizeSeverity('semgrep', 'WARNING', MAP), 'Medium');
  assert.equal(normalizeSeverity('semgrep', 'INFO', MAP), 'Low');

  // CVSS bands (cargo-audit / pip-audit).
  assert.equal(normalizeSeverity('cargo-audit', 9.8, MAP), 'Critical');
  assert.equal(normalizeSeverity('cargo-audit', 7.5, MAP), 'High');
  assert.equal(normalizeSeverity('cargo-audit', 5.0, MAP), 'Medium');
  assert.equal(normalizeSeverity('pip-audit', 2.1, MAP), 'Low');

  // pnpm named levels.
  assert.equal(normalizeSeverity('pnpm-audit', 'critical', MAP), 'Critical');
  assert.equal(normalizeSeverity('pnpm-audit', 'moderate', MAP), 'Medium');

  // Conservative defaults (spec edge cases).
  assert.equal(normalizeSeverity('cargo-audit', 'unscored', MAP), 'High');
  assert.equal(normalizeSeverity('pip-audit', 'unscored', MAP), 'High');
  assert.equal(normalizeSeverity('cargo-audit', 'informational', MAP), 'Low');
});

test('normalizeSeverity FAILS FAST on an unmapped native severity (no silent Low)', () => {
  assert.throws(() => normalizeSeverity('semgrep', 'CATASTROPHE', MAP), /unmapped|unknown|severity/i);
  assert.throws(() => normalizeSeverity('pnpm-audit', 'spicy', MAP), /unmapped|unknown|severity/i);
});

// ── blocking derivation (data-model) ─────────────────────────────────────────
test('deriveBlocking: SAST High/Critical always blocks; Medium/Low never', () => {
  assert.equal(deriveBlocking({ kind: 'sast', severity: 'High', scope: null }), true);
  assert.equal(deriveBlocking({ kind: 'sast', severity: 'Critical', scope: null }), true);
  assert.equal(deriveBlocking({ kind: 'sast', severity: 'Medium', scope: null }), false);
  assert.equal(deriveBlocking({ kind: 'sast', severity: 'Low', scope: null }), false);
});

test('deriveBlocking: SCA blocks only when High/Critical AND runtime scope', () => {
  assert.equal(deriveBlocking({ kind: 'sca', severity: 'High', scope: 'runtime' }), true);
  assert.equal(deriveBlocking({ kind: 'sca', severity: 'Critical', scope: 'runtime' }), true);
  assert.equal(deriveBlocking({ kind: 'sca', severity: 'High', scope: 'dev' }), false);
  assert.equal(deriveBlocking({ kind: 'sca', severity: 'Medium', scope: 'runtime' }), false);
});

// ── scope classification (research R3) ───────────────────────────────────────
test('classifyScope: package in the runtime set is runtime, otherwise dev', () => {
  const runtime = new Set(['serde', 'tokio']);
  assert.equal(classifyScope('serde', runtime), 'runtime');
  assert.equal(classifyScope('mockall', runtime), 'dev');
});

test('classifyScope: an unclassifiable finding (null runtime set) defaults to runtime (conservative)', () => {
  assert.equal(classifyScope('anything', null), 'runtime');
});

// ── fail-fast on a missing toolchain (FR-015) ────────────────────────────────
test('assertToolchain throws (naming the scanner) when the command is absent', () => {
  assert.throws(
    () => assertToolchain('mcm-definitely-not-a-real-binary-xyz', 'faketool'),
    /faketool/,
  );
});

test('assertToolchain does not throw for a present command (node)', () => {
  assert.doesNotThrow(() => assertToolchain('node', 'node'));
});

// ── the built report conforms to the findings schema (gate input contract) ───
test('buildFindingsReport output validates against contracts/findings.schema.json', () => {
  const findings = [
    {
      scanner: 'semgrep', kind: 'sast', id: 'mcm-no-token-logging',
      title: 'Raw token logged', location: 'src/bff-server/auth.ts:42',
      ecosystem: null, nativeSeverity: 'ERROR', severity: 'High', scope: null,
      blocking: true, fixAvailable: null,
    },
    {
      scanner: 'cargo-audit', kind: 'sca', id: 'RUSTSEC-2099-0001',
      title: 'Vuln in foo', location: 'foo@1.2.3',
      ecosystem: 'cargo', nativeSeverity: '7.5', severity: 'High', scope: 'runtime',
      blocking: true, fixAvailable: '1.2.4',
    },
  ];
  const report = buildFindingsReport({
    scope: 'full',
    scanners: [
      { scanner: 'semgrep', ran: true, findingCount: 1, error: null },
      { scanner: 'cargo-audit', ran: true, findingCount: 1, error: null },
      { scanner: 'pnpm-audit', ran: true, findingCount: 0, error: null },
      { scanner: 'pip-audit', ran: true, findingCount: 0, error: null },
    ],
    findings,
  });

  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(SCHEMA);
  assert.equal(validate(report), true, ajv.errorsText(validate.errors));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedAtScope, 'full');
});

// ── CLI process-level: bad args exit non-zero (exit 2 per contract) ──────────
test('the CLI exits non-zero (2) on an unknown argument', () => {
  const r = spawnSync('node', [ORCH, '--nonsense-flag'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
