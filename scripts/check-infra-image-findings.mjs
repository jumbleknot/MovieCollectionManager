#!/usr/bin/env node
// Infra-image CVE gate (feature 035).
// Contract: specs/035-infra-image-cve-scan/data-model.md ("Gate contract").
//
// Consumes ONLY the normalized findings.json (from infra-image-scan.mjs) + the allowlist
// (security/infra-images/allowlist.yaml — the allowlist IS the baseline, no stored diff). FAILS
// (exit 1) on any `blocking` finding not suppressed by a live allowlist entry. `blocking` = FIXABLE
// Critical (a fix version exists upstream) — matching the sibling cd-deploy Trivy gate
// (`--severity CRITICAL --ignore-unfixed`); fixable High and everything else (unfixable, Medium,
// Low) are printed as warnings and never fail (base OS images carry hundreds of slow-backport High
// CVEs — gating on those is noise). Suppression is gate-only — allowlisted findings stay visible in
// the report. An allowlist entry with a past `expiry` stops suppressing.
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
import {
  WARNING_WINDOW_DAYS, classifyExpiry, selectUnmatched, formatExpiring, formatExpired, formatUnmatched,
} from './allowlist-expiry.mjs';

/**
 * This gate has ONE scanner (Trivy), so the per-scanner guard in `selectUnmatched` collapses to a
 * single label: either the scan produced findings this run, or it produced none and no entry of its
 * is reported as unmatched. Same rule as the SAST gate, one scanner instead of four.
 */
const SCANNER = 'trivy';

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
  // `key` is a stable per-run identity for unmatched-entry detection, NOT the advisory id: this file
  // reuses CVE-2025-68121 across hashicorp/vault and minio/mc, and GHSA-7rqj-j65f-68wh across both
  // langfuse images. Keying on the id alone would let one entry's match cover another's staleness.
  return { key: `${i}:${e.image}:${e.id}`, scanner: SCANNER, image: e.image, id: e.id, imageRe, idRe, justification: e.justification, addedBy: e.addedBy, expiry: e.expiry };
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

/**
 * Does the entry's PATTERN describe this finding, ignoring expiry?
 *
 * Separate from `suppresses` because "matched nothing this run" is orthogonal to the expiry
 * lifecycle: an expired entry that still describes its finding is reported as EXPIRED, not also as
 * UNMATCHED. Reporting one fault twice is noise.
 */
function matchesFinding(entry, f) {
  return entry.imageRe.test(f.image) && entry.idRe.test(f.id);
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

  // A scan that failed or was skipped produces no findings, and must therefore flag none of its
  // entries — that fault belongs to the scanning job to report, not to this check to misattribute.
  const matchedKeys = new Set();
  for (const f of findings) for (const e of allowlist) if (matchesFinding(e, f)) matchedKeys.add(e.key);
  const scannersWithFindings = findings.length ? new Set([SCANNER]) : new Set();
  const unmatched = selectUnmatched(allowlist, matchedKeys, scannersWithFindings);

  return { failures, warnings, suppressed, expiring, expired, unmatched };
}

function line(f) {
  const fix = f.fixAvailable ? ` (fix: ${f.fixedVersion})` : ' (no fix)';
  return `  [${f.image}] ${f.severity} ${f.id} — ${f.pkg} ${f.installed}${fix}`;
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
  console.log('── Infra-image CVE gate summary ───────────────────────');
  if (failures.length) {
    console.log(`Blocking (un-allowlisted fixable Critical): ${failures.length}`);
    for (const sev of SEV_ORDER) for (const f of failures.filter((x) => x.severity === sev)) console.log(line(f));
  }
  if (warnings.length) {
    console.log(`Warnings (non-blocking — fixable High, unfixable, or Medium/Low): ${warnings.length}`);
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
 * hygiene alone, so the weekly signal is never ambiguous about which of the two went wrong.
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
    console.error(`✗ Infra-image gate FAILED: ${result.failures.length} un-allowlisted fixable Critical finding(s). Bump the base image (Renovate) or add a justified allowlist entry (security/infra-images/allowlist.yaml).`);
    return 1;
  }
  console.log('✓ Infra-image gate passed (no un-allowlisted fixable Critical findings).');
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
  // Fixable Critical → blocking (mirrors normalizeTrivy). The gate trusts the report's `blocking` flag.
  const F = (over) => ({ image: 'quay.io/keycloak/keycloak:26.5.5', location: ['a.yaml:1'], id: 'CVE-2026-1000', pkg: 'libfoo', installed: '1.0', fixedVersion: '1.1', severity: 'Critical', fixAvailable: true, blocking: true, ...over });
  const rep = (findings) => ({ schemaVersion: 1, findings });
  const allow = (yaml) => loadAllowlistFromString(yaml);

  // (a) un-allowlisted fixable Critical → 1
  if (gate(rep([F()]), []) !== 1) failures.push('(a) un-allowlisted fixable Critical should FAIL (exit 1)');
  // (b) allowlisted → 0
  const al = allow('- image: "quay\\\\.io/keycloak/.*"\n  id: "CVE-2026-1000"\n  justification: "selftest"\n  addedBy: "selftest"\n');
  if (gate(rep([F()]), al) !== 0) failures.push('(b) allowlisted fixable Critical should PASS (exit 0)');
  // (c) fixable HIGH is non-blocking → 0 (base-image High CVEs are report-only, matching cd-deploy CRITICAL-only)
  if (gate(rep([F({ severity: 'High', blocking: false })]), []) !== 0) failures.push('(c) fixable High should PASS (exit 0)');
  // (d) UNFIXABLE Critical (no fix) is non-blocking → 0
  if (gate(rep([F({ fixAvailable: false, fixedVersion: '', blocking: false })]), []) !== 0) failures.push('(d) unfixable Critical should PASS (exit 0)');
  // (e) Medium is non-blocking → 0
  if (gate(rep([F({ severity: 'Medium', blocking: false })]), []) !== 0) failures.push('(e) Medium should PASS (exit 0)');
  // (f) clean → 0
  if (gate(rep([]), []) !== 0) failures.push('(f) clean report should PASS (exit 0)');
  // (g) blank justification → GateError
  try { allow('- image: "x"\n  id: "y"\n  justification: ""\n  addedBy: "z"\n'); failures.push('(g) blank justification should be rejected'); }
  catch (e) { if (!(e instanceof GateError)) failures.push('(g) blank justification should throw GateError'); }
  // (h) past expiry does not suppress → 1 ; future expiry suppresses → 0
  const expired = allow('- image: "quay\\\\.io/keycloak/.*"\n  id: "CVE-2026-1000"\n  justification: "selftest"\n  addedBy: "selftest"\n  expiry: "2000-01-01"\n');
  if (gate(rep([F()]), expired) !== 1) failures.push('(h) past-expiry entry should NOT suppress (exit 1)');
  const future = allow('- image: "quay\\\\.io/keycloak/.*"\n  id: "CVE-2026-1000"\n  justification: "selftest"\n  addedBy: "selftest"\n  expiry: "2999-01-01"\n');
  if (gate(rep([F()]), future) !== 0) failures.push('(h) future-expiry entry should suppress (exit 0)');

  // ── (g) the warning tier (feature 057) — IDENTICAL behaviour to check-sast-findings.mjs ─────────
  // Contract: specs/057-dependency-security-loop/contracts/check-expiring.cli.md
  //
  // "Both gates behave the same way" (FR-024) is only a claim until both are asserted, so these are
  // the sibling's (g) cases transposed onto this gate's entry shape. The window constant is
  // IMPORTED, never redeclared — there is exactly one definition in the repository.
  const NOW = '2026-08-13';
  const entry = (over = {}) => {
    const f = { image: 'quay\\\\.io/keycloak/.*', id: 'CVE-2026-1000', justification: 'selftest', addedBy: 'selftest', ...over };
    return allow(Object.entries(f).map(([k, v]) => `${k === 'image' ? '- ' : '  '}${k}: "${v}"`).join('\n') + '\n');
  };

  // (g1) inside the window: still suppresses, exit unchanged, and IS reported.
  const g1 = capture(() => gate(rep([F()]), entry({ expiry: '2026-08-23' }), NOW));
  if (g1.code !== 0) failures.push('(g1) an entry inside the warning window must still suppress (exit 0)');
  if (!/EXPIRING SOON/.test(g1.out)) failures.push('(g1) an expiring entry must be reported under EXPIRING SOON');
  if (!/10 days/.test(g1.out)) failures.push('(g1) the EXPIRING SOON line must name the days remaining');

  // (g2) the same entry under --check-expiring is a failure.
  if (capture(() => gate(rep([F()]), entry({ expiry: '2026-08-23' }), NOW, { checkExpiring: true })).code !== 1) failures.push('(g2) --check-expiring must exit 1 on an expiring entry');

  // (g3) expired → re-blocks, and the failure explains itself.
  const g3 = capture(() => gate(rep([F()]), entry({ expiry: '2026-08-01' }), NOW));
  if (g3.code !== 1) failures.push('(g3) an expired entry must stop suppressing (exit 1)');
  if (!/suppressed until 2026-08-01/.test(g3.out)) failures.push('(g3) the expired message must name the former expiry');
  if (!/EXPIRED/.test(g3.out) || !/selftest/.test(g3.out)) failures.push('(g3) the expired message must name who added the entry');

  // (g4) matches nothing, and the scan DID produce findings → reported unmatched.
  const g4allow = entry({ id: 'CVE-2026-9999' });
  if (!/UNMATCHED ENTRIES/.test(capture(() => gate(rep([F()]), g4allow, NOW)).out)) failures.push('(g4) an entry matching nothing must be reported as unmatched');
  if (capture(() => gate(rep([F()]), g4allow, NOW, { checkExpiring: true })).code !== 1) failures.push('(g4) --check-expiring must exit 1 on an unmatched entry');

  // (g5) the case that keeps the signal trustworthy: the scan produced NO findings at all — skipped,
  // failed, or genuinely clean — so none of its entries may be reported as unmatched.
  const g5 = capture(() => gate(rep([]), g4allow, NOW));
  if (/UNMATCHED ENTRIES/.test(g5.out)) failures.push('(g5) a scan with no findings must not flag its entry set as unmatched');
  if (capture(() => gate(rep([]), g4allow, NOW, { checkExpiring: true })).code !== 0) failures.push('(g5) --check-expiring must exit 0 when the scan produced no findings');

  // (g6) everything active and matched.
  if (capture(() => gate(rep([F()]), al, NOW, { checkExpiring: true })).code !== 0) failures.push('(g6) --check-expiring must exit 0 when every entry is active and matched');

  // --check-expiring does not evaluate blocking findings — that is the normal run's job.
  if (capture(() => gate(rep([F()]), [], NOW, { checkExpiring: true })).code !== 0) failures.push('(g7) --check-expiring must ignore blocking findings');

  if (failures.length) {
    console.error('✗ check-infra-image-findings --selftest FAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('✓ check-infra-image-findings --selftest passed (fail on fixable-Critical, allowlist-suppress, fixable-High warn, unfixable warn, medium warn, clean, blank-justification reject, expiry, warning tier + unmatched + --check-expiring).');
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
    // See the matching note in check-sast-findings.mjs. An ABSENT report in --check-expiring mode
    // means "no scanner produced findings", which the FR-023 guard already answers with zero
    // unmatched entries; expiry classification needs only the allowlist. Announced, never assumed.
    // A report that exists but will not parse is still exit 2.
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
