#!/usr/bin/env node
// Infra-image CVE gate (feature 035).
// Contract: specs/035-infra-image-cve-scan/data-model.md ("Gate contract").
//
// Consumes ONLY the normalized findings.json (from infra-image-scan.mjs) + the allowlist
// (security/infra-images/allowlist.yaml — the allowlist IS the baseline, no stored diff). FAILS
// (exit 1) on any `blocking` finding not suppressed by a live allowlist entry. `blocking` = FIXABLE
// High/Critical (a fix version exists upstream); unfixable High/Critical and all Medium/Low are
// printed as warnings and never fail. Suppression is gate-only — allowlisted findings stay visible
// in the report. An allowlist entry with a past `expiry` stops suppressing.
//
// Usage:
//   node scripts/check-infra-image-findings.mjs [--report <findings.json>] [--allowlist <yaml>]
//   node scripts/check-infra-image-findings.mjs --selftest
//
// Exit codes: 0 pass / selftest ok · 1 un-allowlisted blocking finding · 2 bad args /
//             unparseable report / invalid allowlist entry.
//
// MUST NOT print secrets — only finding metadata (image, id, pkg, severity). The scan is on public
// images and keyless, so no credential material is ever in scope.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPORT = resolve(REPO_ROOT, 'security/infra-images/reports/findings.json');
const DEFAULT_ALLOWLIST = resolve(REPO_ROOT, 'security/infra-images/allowlist.yaml');
const SEV_ORDER = ['Critical', 'High', 'Medium', 'Low'];

class GateError extends Error {}

/** Today's date as YYYY-MM-DD (lexicographic compare is valid for ISO dates). */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Validate + compile one allowlist entry. Missing/blank required field or bad regex → GateError. */
function compileEntry(e, i) {
  for (const field of ['image', 'id', 'justification', 'addedBy']) {
    if (!e || typeof e[field] !== 'string' || e[field].trim() === '') {
      throw new GateError(`allowlist entry #${i + 1} has a missing/blank "${field}" — every suppression needs image, id, justification, addedBy.`);
    }
  }
  if (e.expiry !== undefined && (typeof e.expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.expiry))) {
    throw new GateError(`allowlist entry #${i + 1} has an invalid "expiry" (must be an ISO YYYY-MM-DD date).`);
  }
  let imageRe;
  let idRe;
  try {
    imageRe = new RegExp(e.image);
  } catch (err) {
    throw new GateError(`allowlist entry #${i + 1} image is not a valid regex: ${err.message}`);
  }
  try {
    idRe = new RegExp(e.id);
  } catch (err) {
    throw new GateError(`allowlist entry #${i + 1} id is not a valid regex: ${err.message}`);
  }
  return { image: e.image, id: e.id, imageRe, idRe, justification: e.justification, addedBy: e.addedBy, expiry: e.expiry };
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
 * An entry suppresses a finding iff its image regex matches the finding's image AND its id regex
 * matches the finding's advisory id AND the entry has not expired (no expiry, or expiry >= today).
 */
function suppresses(entry, f, now) {
  if (!entry.imageRe.test(f.image)) return false;
  if (!entry.idRe.test(f.id)) return false;
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
  const fix = f.fixAvailable ? ` (fix: ${f.fixedVersion})` : ' (no fix)';
  return `  [${f.image}] ${f.severity} ${f.id} — ${f.pkg} ${f.installed}${fix}`;
}

function printSummary({ failures, warnings, suppressed }) {
  console.log('── Infra-image CVE gate summary ───────────────────────');
  if (failures.length) {
    console.log(`Blocking (un-allowlisted fixable High/Critical): ${failures.length}`);
    for (const sev of SEV_ORDER) for (const f of failures.filter((x) => x.severity === sev)) console.log(line(f));
  }
  if (warnings.length) {
    console.log(`Warnings (non-blocking — unfixable, or Medium/Low): ${warnings.length}`);
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
    console.error(`✗ Infra-image gate FAILED: ${result.failures.length} un-allowlisted fixable High/Critical finding(s). Bump the base image (Renovate) or add a justified allowlist entry (security/infra-images/allowlist.yaml).`);
    return 1;
  }
  console.log('✓ Infra-image gate passed (no un-allowlisted fixable High/Critical findings).');
  return 0;
}

// ── Self-test (repo `--selftest`-then-scan convention) ───────────────────────
function selftest() {
  const failures = [];
  const F = (over) => ({ image: 'quay.io/keycloak/keycloak:26.5.5', location: ['a.yaml:1'], id: 'CVE-2026-1000', pkg: 'libfoo', installed: '1.0', fixedVersion: '1.1', severity: 'High', fixAvailable: true, blocking: true, ...over });
  const rep = (findings) => ({ schemaVersion: 1, findings });
  const allow = (yaml) => loadAllowlistFromString(yaml);

  // (a) un-allowlisted fixable High → 1
  if (gate(rep([F()]), []) !== 1) failures.push('(a) un-allowlisted fixable High should FAIL (exit 1)');
  // (b) allowlisted → 0
  const al = allow('- image: "quay\\\\.io/keycloak/.*"\n  id: "CVE-2026-1000"\n  justification: "selftest"\n  addedBy: "selftest"\n');
  if (gate(rep([F()]), al) !== 0) failures.push('(b) allowlisted fixable High should PASS (exit 0)');
  // (c) UNFIXABLE High (no fix) is non-blocking → 0
  if (gate(rep([F({ fixAvailable: false, fixedVersion: '', blocking: false })]), []) !== 0) failures.push('(c) unfixable High should PASS (exit 0)');
  // (d) Medium is non-blocking → 0
  if (gate(rep([F({ severity: 'Medium', blocking: false })]), []) !== 0) failures.push('(d) Medium should PASS (exit 0)');
  // (e) clean → 0
  if (gate(rep([]), []) !== 0) failures.push('(e) clean report should PASS (exit 0)');
  // (f) blank justification → GateError
  try { allow('- image: "x"\n  id: "y"\n  justification: ""\n  addedBy: "z"\n'); failures.push('(f) blank justification should be rejected'); }
  catch (e) { if (!(e instanceof GateError)) failures.push('(f) blank justification should throw GateError'); }
  // (g) past expiry does not suppress → 1 ; future expiry suppresses → 0
  const expired = allow('- image: "quay\\\\.io/keycloak/.*"\n  id: "CVE-2026-1000"\n  justification: "selftest"\n  addedBy: "selftest"\n  expiry: "2000-01-01"\n');
  if (gate(rep([F()]), expired) !== 1) failures.push('(g) past-expiry entry should NOT suppress (exit 1)');
  const future = allow('- image: "quay\\\\.io/keycloak/.*"\n  id: "CVE-2026-1000"\n  justification: "selftest"\n  addedBy: "selftest"\n  expiry: "2999-01-01"\n');
  if (gate(rep([F()]), future) !== 0) failures.push('(g) future-expiry entry should suppress (exit 0)');

  if (failures.length) {
    console.error('✗ check-infra-image-findings --selftest FAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('✓ check-infra-image-findings --selftest passed (fail, allowlist-suppress, unfixable-warn, medium-warn, clean, blank-justification reject, expiry).');
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
