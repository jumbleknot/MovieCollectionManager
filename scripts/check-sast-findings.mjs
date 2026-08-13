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
import {
  WARNING_WINDOW_DAYS, classifyExpiry, selectUnmatched, formatExpiring, formatExpired, formatUnmatched,
} from './allowlist-expiry.mjs';

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
  // `key` is a stable per-run identity for unmatched-entry detection. It is NOT the advisory id:
  // this file carries two entries sharing `image-size@1.2.1` under different ids, and the sibling
  // infra-image allowlist reuses one id across two images — keying on the id alone would let one
  // entry's match silently cover another entry's staleness.
  return { key: `${i}:${e.scanner}:${e.id}`, scanner: String(e.scanner), id: String(e.id), locationPattern: e.locationPattern, re, justification: e.justification, addedBy: e.addedBy, expiry: e.expiry };
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

/**
 * Does the entry's PATTERN describe this finding, ignoring expiry?
 *
 * Deliberately separate from `suppresses`: "matched nothing this run" is orthogonal to the expiry
 * lifecycle (data-model.md), so an expired entry that still describes its finding is reported as
 * EXPIRED rather than also as UNMATCHED. Reporting it twice for one fault would be noise.
 */
function matchesFinding(entry, f) {
  return entry.scanner === f.scanner && entry.id === f.id && entry.re.test(f.location);
}

/** Partition findings into { failures, warnings, suppressed } plus the allowlist-hygiene review. */
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

  const expiring = allowlist.filter((e) => classifyExpiry(e.expiry, now) === 'expiring');
  const expired = allowlist.filter((e) => classifyExpiry(e.expiry, now) === 'expired');

  // Unmatched is evaluated ONLY for scanners that produced at least one finding in this run. A
  // skipped, failed or clean scanner must never flag its whole entry set — otherwise the weekly
  // check goes red claiming stale allowlist hygiene when the real fault is a scan that never ran,
  // which is the scanning job's failure to report, not this one's to misattribute.
  const matchedKeys = new Set();
  for (const f of findings) for (const e of allowlist) if (matchesFinding(e, f)) matchedKeys.add(e.key);
  const scannersWithFindings = new Set(findings.map((f) => f.scanner));
  const unmatched = selectUnmatched(allowlist, matchedKeys, scannersWithFindings);

  return { failures, warnings, suppressed, expiring, expired, unmatched };
}

function line(f) {
  const tag = f.scope === 'dev' ? `${f.scanner}/dev` : f.scanner;
  return `  [${tag}] ${f.severity} ${f.id} — ${f.location}`;
}

function printAllowlistReview({ expiring, expired, unmatched }, now) {
  if (expiring.length) {
    console.log('EXPIRING SOON (suppressing for now)');
    console.log(formatExpiring(expiring, now));
  }
  if (expired.length) {
    console.log('EXPIRED (no longer suppressing)');
    for (const e of expired) console.log(formatExpired(e));
  }
  if (unmatched.length) {
    console.log('UNMATCHED ENTRIES (suppressed nothing this run)');
    console.log(formatUnmatched(unmatched));
  }
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

/**
 * Run the gate. Returns exit code (0 pass / 1 fail).
 *
 * `checkExpiring` is REPORT-ONLY: it skips the blocking-finding gate entirely and fails on allowlist
 * hygiene alone. Conflating the two would make the weekly signal ambiguous about which of them went
 * wrong, so a repository with un-allowlisted blocking findings and a clean allowlist exits 0 here —
 * the blocking gate is the normal run's job.
 */
export function gate(report, allowlist, now = today(), { checkExpiring = false } = {}) {
  const result = evaluate(report, allowlist, now);

  if (checkExpiring) {
    printAllowlistReview(result, now);
    const total = result.expiring.length + result.expired.length + result.unmatched.length;
    if (total) {
      console.error(
        `✗ allowlist expiry check FAILED: ${result.expiring.length} expiring within ${WARNING_WINDOW_DAYS} days, ` +
        `${result.expired.length} expired, ${result.unmatched.length} matching nothing this run. ` +
        'Remediate or re-justify before the expiry blocks every branch.',
      );
      return 1;
    }
    console.log(`✓ allowlist expiry check passed (no entry expiring within ${WARNING_WINDOW_DAYS} days, expired, or unmatched).`);
    return 0;
  }

  printSummary(result);
  // Advisory on a normal run — printing these MUST NOT move the exit code (FR-021, SC-007).
  printAllowlistReview(result, now);
  if (result.failures.length) {
    console.error(`✗ SAST gate FAILED: ${result.failures.length} un-allowlisted blocking (High/Critical runtime) finding(s). Fix them or add a justified allowlist entry (security/sast/allowlist.yaml).`);
    return 1;
  }
  console.log('✓ SAST gate passed (no un-allowlisted blocking findings).');
  return 0;
}

// ── Self-test (repo `--selftest`-then-scan convention) ───────────────────────

/** Run `fn`, returning its value plus everything it printed. The (g) cases assert on both. */
function capture(fn) {
  const chunks = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a) => chunks.push(a.join(' '));
  console.error = (...a) => chunks.push(a.join(' '));
  try {
    return { code: fn(), out: chunks.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

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

  // ── (g) the warning tier (feature 057) ──────────────────────────────────────
  // Contract: specs/057-dependency-security-loop/contracts/check-expiring.cli.md
  //
  // These assert OUTPUT as well as exit codes, because the binding constraint of the whole story is
  // that the exit code does NOT move (FR-021/SC-007) — so an exit-code-only test would pass just as
  // happily against a change that printed nothing at all.
  const NOW = '2026-08-13';
  const entry = (over = {}) => {
    const fields = { scanner: 'semgrep', id: 'mcm-no-token-logging', locationPattern: 'src/bff-server/a\\\\.ts:.*', justification: 'selftest', addedBy: 'selftest', ...over };
    return allow(Object.entries(fields).map(([k, v]) => `${k === 'scanner' ? '- ' : '  '}${k}: "${v}"`).join('\n') + '\n');
  };

  // (g1) an entry expiring inside the window still suppresses, exits 0, and IS reported.
  const g1 = capture(() => gate(rep([F()]), entry({ expiry: '2026-08-23' }), NOW));
  if (g1.code !== 0) failures.push('(g1) an entry inside the warning window must still suppress (exit 0)');
  if (!/EXPIRING SOON/.test(g1.out)) failures.push('(g1) an expiring entry must be reported under EXPIRING SOON');
  if (!/10 days/.test(g1.out)) failures.push('(g1) the EXPIRING SOON line must name the days remaining');

  // (g2) the same entry under --check-expiring is a failure.
  const g2 = capture(() => gate(rep([F()]), entry({ expiry: '2026-08-23' }), NOW, { checkExpiring: true }));
  if (g2.code !== 1) failures.push('(g2) --check-expiring must exit 1 on an expiring entry');

  // (g3) an expired entry re-blocks, and the failure EXPLAINS ITSELF.
  const g3 = capture(() => gate(rep([F()]), entry({ expiry: '2026-08-01' }), NOW));
  if (g3.code !== 1) failures.push('(g3) an expired entry must stop suppressing (exit 1)');
  if (!/suppressed until 2026-08-01/.test(g3.out)) failures.push('(g3) the expired message must name the former expiry');
  if (!/EXPIRED/.test(g3.out) || !/selftest/.test(g3.out)) failures.push('(g3) the expired message must name who added the entry');

  // (g4) an entry matching nothing, whose scanner DID produce findings, is reported unmatched.
  const g4allow = entry({ id: 'some-other-rule' });
  const g4 = capture(() => gate(rep([F()]), g4allow, NOW));
  if (!/UNMATCHED ENTRIES/.test(g4.out)) failures.push('(g4) an entry matching nothing must be reported as unmatched');
  if (capture(() => gate(rep([F()]), g4allow, NOW, { checkExpiring: true })).code !== 1) failures.push('(g4) --check-expiring must exit 1 on an unmatched entry');

  // (g5) THE CASE THAT KEEPS THE SIGNAL TRUSTWORTHY. Same unmatched entry, but its scanner produced
  // no findings at all — skipped, failed, or genuinely clean. It must NOT be reported, or the weekly
  // check goes red claiming stale allowlist hygiene when the real fault is a scan that never ran.
  const g5allow = entry({ scanner: 'pip-audit', id: 'PYSEC-2026-0001', locationPattern: '.*' });
  const g5 = capture(() => gate(rep([F()]), g5allow, NOW));
  if (/UNMATCHED ENTRIES/.test(g5.out)) failures.push('(g5) an entry whose scanner produced NO findings must not be reported unmatched');
  if (capture(() => gate(rep([F()]), g5allow, NOW, { checkExpiring: true })).code !== 0) failures.push('(g5) --check-expiring must exit 0 when the only unmatched entry belongs to a scanner with no findings');

  // (g6) everything active and matched — the quiet case the window was chosen to maximise.
  if (capture(() => gate(rep([F()]), al, NOW, { checkExpiring: true })).code !== 0) failures.push('(g6) --check-expiring must exit 0 when every entry is active and matched');

  // --check-expiring does NOT evaluate blocking findings: an un-allowlisted blocking finding with a
  // clean allowlist is the normal run's business, and conflating them makes the weekly signal
  // ambiguous about which of the two things went wrong.
  if (capture(() => gate(rep([F()]), [], NOW, { checkExpiring: true })).code !== 0) failures.push('(g7) --check-expiring must ignore blocking findings');

  if (failures.length) {
    console.error('✗ check-sast-findings --selftest FAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('✓ check-sast-findings --selftest passed (fail, allowlist-suppress, dev-warn, clean, blank-justification reject, expiry, warning tier + unmatched + --check-expiring).');
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  let reportPath = DEFAULT_REPORT;
  let allowlistPath = DEFAULT_ALLOWLIST;
  let checkExpiring = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') reportPath = argv[++i];
    else if (argv[i] === '--allowlist') allowlistPath = argv[++i];
    else if (argv[i] === '--check-expiring') checkExpiring = true;
    else { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (e) {
    // An ABSENT report in --check-expiring mode is not an error, and this distinction is
    // load-bearing. That mode never evaluates blocking findings; it reads the allowlist, and uses the
    // report only to decide which scanners produced findings. "No report" is exactly "no scanner
    // produced findings", which the FR-023 guard already answers correctly with zero unmatched
    // entries. The weekly check runs in the infra-image-scan job, which does NOT produce the SAST
    // report — so exiting 2 here would make the signal permanently red for a reason unrelated to
    // allowlist hygiene, the precise false-alarm class this feature exists to remove.
    //
    // It is announced rather than assumed, so a missing instrument never reads as a clean pass. A
    // report that EXISTS but will not parse is still exit 2 on both paths.
    if (checkExpiring && e.code === 'ENOENT') {
      console.log(`ℹ no scan report at ${reportPath} — expiry/expired classification still runs from the allowlist; UNMATCHED detection is skipped (no scanner produced findings).`);
      report = { findings: [] };
    } else {
      console.error(`✗ could not read/parse report ${reportPath}: ${e.message}`);
      process.exit(2);
    }
  }
  let allowlist;
  try {
    allowlist = loadAllowlist(allowlistPath);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  process.exit(gate(report, allowlist, today(), { checkExpiring }));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
