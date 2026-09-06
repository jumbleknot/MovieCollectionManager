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
  summarizeBlindedRules,
  isScanTarget,
  ruleFixturePairs,
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

// ── Blinded rules (item #224) ────────────────────────────────────────────────
//
// Semgrep reports a rule it could not RUN in `errors[]`, never in `results[]` — so a rule that has
// gone blind contributes exactly zero findings and is indistinguishable, from the gate's input,
// from a rule that found nothing because the code is clean. Measured on main 2026-09-06:
// `gha-curl-pipe-shell` produced 36 such errors and 0 findings while six `curl … | sh` lines sat in
// the workflows. Carrying the counts into the report is what lets the gate say which it was.

test('blinded-rule summary groups the scanner\'s own errors by rule, counting distinct files', () => {
  const errors = [
    { type: ['PartialParsing', [{}]], rule_id: 'r.blind', path: '.forgejo/workflows/app-ci.yml', level: 'warn' },
    { type: ['PartialParsing', [{}]], rule_id: 'r.blind', path: '.forgejo/workflows/app-ci.yml', level: 'warn' },
    { type: ['PartialParsing', [{}]], rule_id: 'r.blind', path: '.forgejo/workflows/guardrails.yml', level: 'warn' },
    { type: 'Internal matching error', rule_id: 'r.blind', path: '.forgejo/workflows/cd-deploy.yml', level: 'warn' },
    { type: ['PartialParsing', [{}]], rule_id: 'r.other', path: '.forgejo/workflows/renovate.yml', level: 'warn' },
  ];
  assert.deepEqual(summarizeBlindedRules(errors), [
    { ruleId: 'r.blind', errorCount: 4, fileCount: 3 },
    { ruleId: 'r.other', errorCount: 1, fileCount: 1 },
  ]);
});

// MEASURED, not assumed. In semgrep 1.169.0's JSON, a `PartialParsing` error carries the rule name
// ONLY inside its message prose — the structured `rule_id` field is absent. On the run that prompted
// item #224, 36 of 39 errors were of that shape: reading `rule_id` alone reports 3, which understates
// the blindness by an order of magnitude and makes it look like a rounding error rather than a rule
// that saw nothing at all.
test('the rule name is recovered from the message when the structured rule_id is absent', () => {
  const errors = [
    {
      code: 3,
      level: 'warn',
      type: ['PartialParsing', [{}]],
      path: '.forgejo/workflows/app-ci.yml',
      message: "Syntax error at line .forgejo/workflows/app-ci.yml:291:\n When parsing a snippet as Bash for metavariable-pattern in rule 'yaml.gha.gha-curl-pipe-shell', `bash scripts/ci-log-step.sh x bash -e /dev/stdin <<'CI` was unexpected",
    },
    {
      code: 2,
      level: 'warn',
      type: 'Internal matching error',
      rule_id: 'yaml.gha.gha-curl-pipe-shell',
      path: '.forgejo/workflows/cd-deploy.yml',
      message: 'Internal matching error when running yaml.gha.gha-curl-pipe-shell on .forgejo/workflows/cd-deploy.yml',
    },
  ];
  // Both forms are the SAME blinded rule and must aggregate into one row, not two.
  assert.deepEqual(summarizeBlindedRules(errors), [
    { ruleId: 'yaml.gha.gha-curl-pipe-shell', errorCount: 2, fileCount: 2 },
  ]);
});

test('an error carrying no rule_id is not attributed to a rule', () => {
  // A target that simply failed to parse is the SCANNER'S problem with a file, not a blinded rule.
  // Reporting it as one would put a rule name on the gate's output that never went blind.
  const errors = [
    { type: 'SyntaxError', path: 'src/broken.ts', level: 'warn' },
    { type: ['PartialParsing', [{}]], rule_id: null, path: 'src/other.ts', level: 'warn' },
  ];
  assert.deepEqual(summarizeBlindedRules(errors), []);
});

test('no errors, or a missing errors array, summarizes to nothing', () => {
  assert.deepEqual(summarizeBlindedRules([]), []);
  assert.deepEqual(summarizeBlindedRules(undefined), []);
});

test('a report carrying blindedRules still validates against the findings contract', () => {
  const report = buildFindingsReport({
    scope: 'full',
    scanners: [
      {
        scanner: 'semgrep', ran: true, findingCount: 0, error: null,
        blindedRules: [{ ruleId: 'r.blind', errorCount: 36, fileCount: 7 }],
      },
    ],
    findings: [],
  });
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(SCHEMA);
  assert.equal(validate(report), true, ajv.errorsText(validate.errors));
});

// ── What --scope changed actually hands to Semgrep (item #224) ───────────────
//
// On a pull request CI runs `--scope changed`, which passes an explicit target list. A rule can only
// fire on a file that is IN that list, so the extension filter — not the rule — decides what a PR is
// gated on. Workflow YAML was absent from it, which meant `mcm-ci-curl-pipe-shell` (and the blinded
// community rule before it) could only ever run on the post-merge full scan. Caught after merge is
// not caught: item #224's fourth criterion is about the pull request that ADDS the `curl … | sh`.

test('a changed workflow file is scanned, so a PR adding curl-pipe-shell is gated before merge', () => {
  assert.equal(isScanTarget('.forgejo/workflows/guardrails.yml'), true);
  assert.equal(isScanTarget('.forgejo/workflows/app-ci.yaml'), true);
  assert.equal(isScanTarget('.github/workflows/release.yml'), true);
});

test('the first-party code surfaces are unchanged', () => {
  for (const p of [
    'frontend/mcm-app/src/bff-server/logger.ts',
    'frontend/mcm-app/app/index.tsx',
    'agents/movie-assistant/src/graph.py',
    'scripts/sast-scan.mjs',
  ]) assert.equal(isScanTarget(p), true, p);
});

test('YAML outside the workflow trees stays out of the changed set', () => {
  // Widening the filter to every .yml would pull compose files, Komodo syncs and the security config
  // tree into a PR-scoped scan against packs written for TS/JS/Python code. The rule that needed
  // this is scoped to the workflow trees, so the target filter is too.
  for (const p of [
    'infrastructure-as-code/docker-compose.yml',
    'security/sast/allowlist.yaml',
    '.forgejo/workflows/nested/deep.yml',
    'renovate.json',
    'backend/mc-service/src/main.rs',
    'README.md',
  ]) assert.equal(isScanTarget(p), false, p);
});

// ── Custom-rule fixtures (item #224) ─────────────────────────────────────────
//
// The fixtures under security/sast/rules/ shipped with feature 033 and NOTHING RAN THEM: at the time
// item #224 was worked, `semgrep --test` appeared in no workflow, no Nx target and no script, so four
// rules' `ruleid:`/`ok:` annotations had been decoration for months. `--test-rules` runs them now.
//
// The subtler half is that `semgrep --test` SKIPS a rule with no fixture rather than failing on it —
// measured: "4/4 ✓ All tests passed" while five rule files sat in the directory. A green tick over a
// silently-skipped rule is the same shape of false assurance as the blinded rule this item is about.

test('every custom rule is paired with a fixture semgrep --test will actually run', () => {
  const pairs = ruleFixturePairs();
  assert.ok(pairs.length >= 5, `expected the custom rules to be found (got ${pairs.length})`);
  const unfixtured = pairs.filter((p) => p.fixtures.length === 0).map((p) => p.rule);
  assert.deepEqual(
    unfixtured,
    [],
    'a rule with no fixture is SKIPPED by `semgrep --test`, not failed — so "N/N passed" would be ' +
      'reported over a rule nothing checked. Add a same-stem fixture: `<rule>.ts` / `<rule>.py` for ' +
      'a code rule, `<rule>.test.yml` for a YAML one (a bare `<rule>.yaml` collides with the rule).',
  );
});

test('a fixture file is never mistaken for a rule file', () => {
  // `--config security/sast/rules/` loads every .yaml/.yml in the directory as RULES. The YAML rule's
  // fixture therefore has to be named so it is not one, which is why it is `.test.yml`.
  const pairs = ruleFixturePairs();
  assert.ok(
    !pairs.some((p) => /\.test\.ya?ml$/.test(p.rule)),
    'a *.test.yml fixture must not be enumerated as a rule',
  );
  const yamlRule = pairs.find((p) => p.rule === 'mcm-ci-curl-pipe-shell.yaml');
  assert.ok(yamlRule, 'the YAML rule must be enumerated');
  assert.deepEqual(yamlRule.fixtures, ['mcm-ci-curl-pipe-shell.test.yml']);
});
