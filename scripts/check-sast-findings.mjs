#!/usr/bin/env node
// SAST/SCA merge gate (feature 033, T020 / T026).
// Contract: specs/033-sast-semgrep/contracts/check-sast-findings.cli.md.
//
// Consumes ONLY the normalized findings.json (from sast-scan.mjs) + security/sast/allowlist.yaml
// (the allowlist IS the baseline — no stored diff). FAILS (exit 1) on any `blocking` finding not
// suppressed by an allowlist entry. Non-blocking findings (Medium/Low, or dev-scope SCA) are printed
// as warnings and never fail. Suppression is gate-only — allowlisted findings stay visible in the
// report (FR-010). An allowlist entry with a past `expiry` stops suppressing (FR-011).
//
// Usage:
//   node scripts/check-sast-findings.mjs [--report <findings.json>] [--allowlist <yaml>]
//   node scripts/check-sast-findings.mjs --selftest
//
// Exit codes: 0 pass / selftest ok · 1 un-allowlisted blocking finding present · 2 bad args /
//             unparseable report / invalid allowlist entry.
//
// MUST NOT print secrets — only finding metadata (scanner, id, location, severity), already scrubbed
// by the orchestrator.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPORT = resolve(REPO_ROOT, 'security/sast/reports/findings.json');
const DEFAULT_ALLOWLIST = resolve(REPO_ROOT, 'security/sast/allowlist.yaml');
const SEV_ORDER = ['Critical', 'High', 'Medium', 'Low'];

class GateError extends Error {}

/** Today's date as YYYY-MM-DD (for expiry comparison; lexicographic compare is valid for ISO dates). */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Validate + compile one allowlist entry. Missing/blank required field or bad regex → GateError. */
function compileEntry(e, i) {
  for (const field of ['scanner', 'id', 'locationPattern', 'justification', 'addedBy']) {
    if (!e || typeof e[field] !== 'string' || e[field].trim() === '') {
      throw new GateError(`allowlist entry #${i + 1} has a missing/blank "${field}" — every suppression needs scanner, id, locationPattern, justification, addedBy.`);
    }
  }
  if (e.expiry !== undefined && (typeof e.expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.expiry))) {
    throw new GateError(`allowlist entry #${i + 1} has an invalid "expiry" (must be an ISO YYYY-MM-DD date).`);
  }
  let re;
  try {
    re = new RegExp(e.locationPattern);
  } catch (err) {
    throw new GateError(`allowlist entry #${i + 1} locationPattern is not a valid regex: ${err.message}`);
  }
  return { scanner: String(e.scanner), id: String(e.id), locationPattern: e.locationPattern, re, justification: e.justification, addedBy: e.addedBy, expiry: e.expiry };
}

export function loadAllowlist(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return []; // no allowlist file → nothing suppressed
  }
  return loadAllowlistFromString(raw);
}

function loadAllowlistFromString(yaml) {
  const parsed = parseYaml(yaml) ?? [];
  if (!Array.isArray(parsed)) throw new GateError('allowlist must be a YAML list');
  return parsed.map(compileEntry);
}

/**
 * An entry suppresses a finding iff scanner AND id match, the locationPattern matches the finding's
 * location, and the entry has not expired (no expiry, or expiry >= today).
 */
function suppresses(entry, f, now) {
  if (entry.scanner !== f.scanner || entry.id !== f.id) return false;
  if (!entry.re.test(f.location)) return false;
  if (entry.expiry && entry.expiry < now) return false; // expired → no longer suppresses
  return true;
}

/** Partition findings into { failures, warnings, suppressed }. */
export function evaluate(report, allowlist, now = today()) {
  const findings = report?.findings ?? [];
  const failures = [];
  const warnings = [];
  const suppressed = [];
  for (const f of findings) {
    const hit = allowlist.find((e) => suppresses(e, f, now));
    if (f.blocking && hit) suppressed.push({ ...f, allowlist: hit });
    else if (f.blocking) failures.push(f);
    else warnings.push(f);
  }
  return { failures, warnings, suppressed };
}

function line(f) {
  const tag = f.scope === 'dev' ? `${f.scanner}/dev` : f.scanner;
  return `  [${tag}] ${f.severity} ${f.id} — ${f.location}`;
}

function printSummary({ failures, warnings, suppressed }) {
  console.log('── SAST/SCA gate summary ──────────────────────────────');
  if (failures.length) {
    console.log(`Blocking (un-allowlisted): ${failures.length}`);
    for (const sev of SEV_ORDER) for (const f of failures.filter((x) => x.severity === sev)) console.log(line(f));
  }
  if (warnings.length) {
    console.log(`Warnings (non-blocking — Medium/Low or dev-scope): ${warnings.length}`);
    for (const f of warnings.slice(0, 30)) console.log(line(f));
    if (warnings.length > 30) console.log(`  … and ${warnings.length - 30} more`);
  }
  if (suppressed.length) {
    console.log(`Allowlisted (still visible in reports, not gated): ${suppressed.length}`);
    for (const f of suppressed) console.log(`${line(f)} — allowlisted by ${f.allowlist.addedBy}`);
  }
  console.log('───────────────────────────────────────────────────────');
}

/** Run the gate. Returns exit code (0 pass / 1 fail). */
export function gate(report, allowlist, now = today()) {
  const result = evaluate(report, allowlist, now);
  printSummary(result);
  if (result.failures.length) {
    console.error(`✗ SAST gate FAILED: ${result.failures.length} un-allowlisted blocking (High/Critical runtime) finding(s). Fix them or add a justified allowlist entry (security/sast/allowlist.yaml).`);
    return 1;
  }
  console.log('✓ SAST gate passed (no un-allowlisted blocking findings).');
  return 0;
}

// ── Self-test (repo `--selftest`-then-scan convention) ───────────────────────
function selftest() {
  const failures = [];
  const F = (over) => ({ scanner: 'semgrep', kind: 'sast', id: 'mcm-no-token-logging', title: 't', location: 'src/bff-server/a.ts:1', ecosystem: null, nativeSeverity: 'ERROR', severity: 'High', scope: null, blocking: true, fixAvailable: null, ...over });
  const rep = (findings) => ({ schemaVersion: 1, generatedAtScope: 'full', scanners: [], findings });
  const allow = (yaml) => loadAllowlistFromString(yaml);

  // (a) un-allowlisted blocking → 1
  if (gate(rep([F()]), []) !== 1) failures.push('(a) un-allowlisted blocking High should FAIL (exit 1)');
  // (b) allowlisted → 0
  const al = allow('- scanner: "semgrep"\n  id: "mcm-no-token-logging"\n  locationPattern: "src/bff-server/a\\\\.ts:.*"\n  justification: "selftest"\n  addedBy: "selftest"\n');
  if (gate(rep([F()]), al) !== 0) failures.push('(b) allowlisted blocking High should PASS (exit 0)');
  // (c) dev-scope non-blocking → 0
  if (gate(rep([F({ kind: 'sca', scanner: 'pnpm-audit', scope: 'dev', blocking: false })]), []) !== 0) failures.push('(c) dev-scope non-blocking should PASS (exit 0)');
  // (d) clean → 0
  if (gate(rep([]), []) !== 0) failures.push('(d) clean report should PASS (exit 0)');
  // (e) blank justification → GateError
  try { allow('- scanner: "semgrep"\n  id: "x"\n  locationPattern: ".*"\n  justification: ""\n  addedBy: "y"\n'); failures.push('(e) blank justification should be rejected'); }
  catch (e) { if (!(e instanceof GateError)) failures.push('(e) blank justification should throw GateError'); }
  // (f) past expiry does not suppress → 1 ; future expiry suppresses → 0
  const expired = allow('- scanner: "semgrep"\n  id: "mcm-no-token-logging"\n  locationPattern: "src/bff-server/a\\\\.ts:.*"\n  justification: "selftest"\n  addedBy: "selftest"\n  expiry: "2000-01-01"\n');
  if (gate(rep([F()]), expired) !== 1) failures.push('(f) past-expiry entry should NOT suppress (exit 1)');
  const future = allow('- scanner: "semgrep"\n  id: "mcm-no-token-logging"\n  locationPattern: "src/bff-server/a\\\\.ts:.*"\n  justification: "selftest"\n  addedBy: "selftest"\n  expiry: "2999-01-01"\n');
  if (gate(rep([F()]), future) !== 0) failures.push('(f) future-expiry entry should suppress (exit 0)');

  if (failures.length) {
    console.error('✗ check-sast-findings --selftest FAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('✓ check-sast-findings --selftest passed (fail, allowlist-suppress, dev-warn, clean, blank-justification reject, expiry).');
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  let reportPath = DEFAULT_REPORT;
  let allowlistPath = DEFAULT_ALLOWLIST;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') reportPath = argv[++i];
    else if (argv[i] === '--allowlist') allowlistPath = argv[++i];
    else { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (e) {
    console.error(`✗ could not read/parse report ${reportPath}: ${e.message}`);
    process.exit(2);
  }
  let allowlist;
  try {
    allowlist = loadAllowlist(allowlistPath);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  process.exit(gate(report, allowlist));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
