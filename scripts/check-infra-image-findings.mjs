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
import { enumerateImages, readInfraFiles } from './infra-image-scan.mjs';

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
  // Item #1130. An `image` key is a regex tested against the scanned `repo:tag@sha256:…`. Unanchored,
  // it also matches any image whose NAME contains the string; without a digest it keeps suppressing
  // across every rebuild of a moving tag (`postgres:18-alpine`), so an acceptance made for one set of
  // bytes silently carries over to the next. Anchored + digest makes each acceptance about the bytes
  // that were triaged — a Renovate digest bump re-evaluates it, which is the point.
  if (!e.image.startsWith('^')) {
    throw new GateError(`allowlist entry #${i + 1} image '${e.image}' is not anchored — start it with ^ so it cannot match an image whose name merely contains it.`);
  }
  if (!/@sha256:[0-9a-f]{12,64}/.test(e.image)) {
    throw new GateError(`allowlist entry #${i + 1} image '${e.image}' pins no digest — add @sha256:<at least 12 hex> of the image that was triaged, so a rebuild re-evaluates the acceptance.`);
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
  // reused CVE-2025-68121 across hashicorp/vault and a since-retired object-store image, and GHSA-7rqj-j65f-68wh across both
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

/**
 * The image set that may judge an entry STALE (item #1136), or null when this run may not.
 *
 * Item #423 scopes UNMATCHED to the images the run scanned, which is right for a single-image run and
 * a hole on the full sweep: an entry keyed to a digest the repository has moved off targets an image
 * no run scans, so it was out of scope on EVERY run and silent until its expiry. Staleness is a
 * property of the allowlist against the REPOSITORY, so its input is the enumerated set — what
 * `infra-image-scan.mjs --list` prints — never the scanned set, and only a sweep may apply it.
 *
 *   scope 'sweep'           → the enumerated set
 *   scope 'image'           → null (item #423: one image scanned, every other entry is out of scope)
 *   reportAbsent (ENOENT)   → the enumerated set. Only the weekly sweep job runs --check-expiring, and
 *                             staleness needs no scan, so a broken scan step must not blind it too.
 *   anything else           → GateError. Guessing either way reintroduces a defect silently.
 *
 * An enumeration with an UNRESOLVED ref (a `${REGISTRY_HOST}` image with the variable unset) is
 * incomplete, and an entry for that image would be flagged falsely — refused, as the scanner refuses.
 *
 * `enumerate` is injectable for the selftest; main() passes the real enumeration.
 */
export function staleScope(report, enumerate = enumerateRepoImages) {
  if (report?.scope === 'image') return null;
  if (report?.scope !== 'sweep' && report?.reportAbsent !== true) {
    throw new GateError(`report has no recognised \`scope\` (got ${JSON.stringify(report?.scope)}; expected 'sweep' or 'image') — regenerate it with scripts/infra-image-scan.mjs. Stale-entry detection runs only on a full sweep (item #1136) and cannot tell one from a single-image run without it.`);
  }
  const { refs, unresolved } = enumerate();
  if (unresolved.length) {
    throw new GateError(`REGISTRY_HOST is not set, so ${unresolved.length} image ref(s) could not be enumerated (${unresolved.join(', ')}) — stale-entry detection needs the repository's COMPLETE image set. Set REGISTRY_HOST and re-run.`);
  }
  return refs;
}

/** The repository's third-party image refs, exactly as `infra-image-scan.mjs --list` enumerates them. */
function enumerateRepoImages() {
  const refs = enumerateImages(readInfraFiles()).map((i) => i.ref);
  return { refs, unresolved: [...enumerateImages.unresolved] };
}

/** Partition findings into { failures, warnings, suppressed } plus the allowlist-hygiene review. */
export function evaluate(report, allowlist, now = today(), { repoImages = null } = {}) {
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

  // STALE (item #1136): on a sweep, an entry whose image regex matches NO image the repository
  // references. `repoImages` is null on a single-image run (see staleScope), which keeps item #423.
  // Computed before the absent-report exemption below: it needs no scan, only the repository.
  const stale = Array.isArray(repoImages) ? allowlist.filter((e) => !repoImages.some((img) => e.imageRe.test(img))) : [];
  const staleKeys = new Set(stale.map((e) => e.key));

  // A scan that failed or was skipped produces no findings, and must therefore flag none of its
  // entries — that fault belongs to the scanning job to report, not to this check to misattribute.
  const matchedKeys = new Set();
  for (const f of findings) for (const e of allowlist) if (matchesFinding(e, f)) matchedKeys.add(e.key);
  const scannersWithFindings = findings.length ? new Set([SCANNER]) : new Set();

  // WHICH ENTRIES THIS RUN IS ENTITLED TO JUDGE (item #423). Two jobs consult this one allowlist —
  // the sweep, which scans every pulled third-party image, and a single-image run (feature 069's
  // object-store builder until feature 080; cd-deploy's scan-push.sh today), which scans exactly one
  // via --image — and both label their findings with the same literal SCANNER. So the scanner guard
  // above cannot separate them, and each used to report the other's live entries as suppressing
  // nothing: 16 false lines on a single-image run, every one of them arguing to delete an entry that
  // is actively suppressing a finding on some other image.
  //
  // `generatedForImages` is the run's scanned set — already written by infra-image-scan.mjs, so this
  // needs no new plumbing. An entry whose image regex matches none of it is out of scope: silent.
  //
  // REQUIRED, NOT OPTIONAL. Defaulting a missing field to "everything is in scope" would restore the
  // old behaviour silently, on a gate that still exits 0 — the exact failure mode this check exists
  // to avoid. A producer that stops writing the field fails here instead.
  // THE ONE EXEMPTION, AND WHY IT IS NOT A HOLE — the sibling of the note in check-sast-findings.mjs,
  // and found the same way: by running the weekly step verbatim rather than each command alone. An
  // ANNOUNCED absent report (`main()`'s ENOENT path under --check-expiring) has no scanned set because
  // no scan ran to produce one, so the throw below fired on it. In the `infra-image-scan` job the scan
  // step writes this report, so the crash is not reachable there — but it is reachable wherever the
  // expiry tier is run without a scan, and a `bash -e` step then takes every later command with it.
  // Keyed on the explicit marker: a report that EXISTS and omits the field still throws, which is what
  // item #423 wrote this check for. Nothing is waved through — an absent report has zero findings, so
  // there is no in-scope entry whose match could go unchecked.
  if (report?.reportAbsent === true) return { failures, warnings, suppressed, expiring, expired, unmatched: [], stale };

  const scanned = report?.generatedForImages;
  if (!Array.isArray(scanned)) {
    throw new GateError('report has no `generatedForImages` array — regenerate it with scripts/infra-image-scan.mjs. Unmatched-entry detection is scoped to the images this run actually scanned (item #423), and cannot be computed without it.');
  }
  const scopedAllowlist = allowlist.map((e) => ({ ...e, inScope: scanned.some((img) => e.imageRe.test(img)) }));
  // A stale entry is reported once, under STALE — never also under UNMATCHED.
  const unmatched = selectUnmatched(scopedAllowlist, matchedKeys, scannersWithFindings).filter((e) => !staleKeys.has(e.key));

  return { failures, warnings, suppressed, expiring, expired, unmatched, stale };
}

function line(f) {
  const fix = f.fixAvailable ? ` (fix: ${f.fixedVersion})` : ' (no fix)';
  return `  [${f.image}] ${f.severity} ${f.id} — ${f.pkg} ${f.installed}${fix}`;
}

function printAllowlistReview({ expiring, expired, unmatched, stale }, now) {
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
  if (stale.length) {
    console.log('STALE ENTRIES (image matches no image the repository references — delete or re-key after a re-scan)');
    for (const e of stale) console.log(`  ${e.id}  image: ${e.image}  addedBy: ${e.addedBy}`);
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
export function gate(report, allowlist, now = today(), { checkExpiring = false, repoImages = null } = {}) {
  const result = evaluate(report, allowlist, now, { repoImages });

  if (checkExpiring) {
    printAllowlistReview(result, now);
    const total = result.expiring.length + result.expired.length + result.unmatched.length + result.stale.length;
    if (total) {
      console.error(
        `✗ allowlist expiry check FAILED: ${result.expiring.length} expiring within ${WARNING_WINDOW_DAYS} days, ` +
        `${result.expired.length} expired, ${result.unmatched.length} matching nothing this run, ` +
        `${result.stale.length} stale (image no longer referenced by the repository). ` +
        'Remediate or re-justify before the expiry blocks every branch.',
      );
      return 1;
    }
    console.log(`✓ allowlist expiry check passed (no entry expiring within ${WARNING_WINDOW_DAYS} days, expired, unmatched, or stale).`);
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
  // Scanned refs carry their digest (docker:pinDigests), and since item #1130 every entry must too.
  const KC = `quay.io/keycloak/keycloak:26.5.5@sha256:${'a'.repeat(64)}`;
  const KC_RE = '^quay\\\\.io/keycloak/keycloak:26\\\\.5\\\\.5@sha256:aaaaaaaaaaaa';
  const REDIS = `docker.io/library/redis:8.2@sha256:${'b'.repeat(64)}`;
  const F = (over) => ({ image: KC, location: ['a.yaml:1'], id: 'CVE-2026-1000', pkg: 'libfoo', installed: '1.0', fixedVersion: '1.1', severity: 'Critical', fixAvailable: true, blocking: true, ...over });
  // `generatedForImages` is the run's scanned set, written by infra-image-scan.mjs (item #423). It is
  // REQUIRED, so the selftest supplies it exactly as a real report does — a fixture that omits a
  // required field tests a shape the gate will never see.
  const rep = (findings, images = [KC]) => ({ schemaVersion: 1, generatedForImages: images, findings });
  const allow = (yaml) => loadAllowlistFromString(yaml);

  // (a) un-allowlisted fixable Critical → 1
  if (gate(rep([F()]), []) !== 1) failures.push('(a) un-allowlisted fixable Critical should FAIL (exit 1)');
  // (b) allowlisted → 0
  const al = allow(`- image: "${KC_RE}"\n  id: "CVE-2026-1000"\n  justification: "selftest"\n  addedBy: "selftest"\n`);
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
  const expired = allow(`- image: "${KC_RE}"\n  id: "CVE-2026-1000"\n  justification: "selftest"\n  addedBy: "selftest"\n  expiry: "2000-01-01"\n`);
  if (gate(rep([F()]), expired) !== 1) failures.push('(h) past-expiry entry should NOT suppress (exit 1)');
  const future = allow(`- image: "${KC_RE}"\n  id: "CVE-2026-1000"\n  justification: "selftest"\n  addedBy: "selftest"\n  expiry: "2999-01-01"\n`);
  if (gate(rep([F()]), future) !== 0) failures.push('(h) future-expiry entry should suppress (exit 0)');
  // (i) item #1130 — an UNANCHORED image key is rejected (it would match any name containing it)
  try { allow('- image: "quay\\\\.io/keycloak/keycloak:26\\\\.5\\\\.5@sha256:aaaaaaaaaaaa"\n  id: "y"\n  justification: "j"\n  addedBy: "z"\n'); failures.push('(i) an unanchored image key should be rejected'); }
  catch (e) { if (!(e instanceof GateError) || !/not anchored/.test(e.message)) failures.push('(i) an unanchored image key should throw a GateError naming the anchor'); }
  // (j) item #1130 — a key without a digest is rejected (it would carry over to every rebuild of the tag)
  try { allow('- image: "^postgres:18-alpine"\n  id: "y"\n  justification: "j"\n  addedBy: "z"\n'); failures.push('(j) an image key without a digest should be rejected'); }
  catch (e) { if (!(e instanceof GateError) || !/pins no digest/.test(e.message)) failures.push('(j) a digest-less image key should throw a GateError naming the digest'); }
  // (k) …and so is a digest too short to identify anything
  try { allow('- image: "^postgres:18-alpine@sha256:77f5"\n  id: "y"\n  justification: "j"\n  addedBy: "z"\n'); failures.push('(k) a 4-hex digest prefix should be rejected'); }
  catch (e) { if (!(e instanceof GateError)) failures.push('(k) a too-short digest should throw GateError'); }

  // ── (g) the warning tier (feature 057) — IDENTICAL behaviour to check-sast-findings.mjs ─────────
  // Contract: specs/057-dependency-security-loop/contracts/check-expiring.cli.md
  //
  // "Both gates behave the same way" (FR-024) is only a claim until both are asserted, so these are
  // the sibling's (g) cases transposed onto this gate's entry shape. The window constant is
  // IMPORTED, never redeclared — there is exactly one definition in the repository.
  const NOW = '2026-08-13';
  const entry = (over = {}) => {
    const f = { image: KC_RE, id: 'CVE-2026-1000', justification: 'selftest', addedBy: 'selftest', ...over };
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

  // (g7b) THE ABSENT-REPORT PATH MUST NOT CRASH. `main()` synthesises `reportAbsent: true` on its
  // announced ENOENT path; the item #423 scope guard below used to throw on that object, and in a
  // `bash -e` weekly step a throw here takes every later command with it. Found by running the weekly
  // step verbatim after fixing the identical defect in check-sast-findings.mjs — the sibling was only
  // visible once the first command stopped aborting first.
  const g7bAbsent = { findings: [], reportAbsent: true };
  const g7b = capture(() => gate(g7bAbsent, g4allow, NOW, { checkExpiring: true }));
  if (g7b.code !== 0) failures.push(`(g7b) --check-expiring on an ABSENT report must exit 0, got ${g7b.code}`);
  if (/UNMATCHED ENTRIES/.test(g7b.out)) failures.push('(g7b) an absent report must not flag the entry set as unmatched');
  // And the exemption is keyed on the MARKER, not on a missing field: the same object without it still
  // throws. Without this half, `return []` unconditionally would pass the assertion above.
  try {
    gate({ findings: [] }, g4allow, NOW, { checkExpiring: true });
    failures.push('(g7b) a report with no generatedForImages and no reportAbsent marker must still be rejected');
  } catch (e) { if (!(e instanceof GateError)) failures.push('(g7b) the unmarked report must throw GateError'); }

  // ── (g8/g9) scope: the item #423 guard ──────────────────────────────────────────────────────────
  //
  // Two jobs consult this one allowlist — the sweep (every pulled image) and a single-image run
  // (one image, via --image: cd-deploy's scan-push.sh; feature 069's object-store builder until 080) — and every entry carries the same literal scanner `trivy`. So
  // the (g5) scanner guard cannot tell the two runs apart, and before this each flagged the other's
  // LIVE entries as suppressing nothing. Reproduced on `main`: a single-image run against the real
  // allowlist produced 16 such lines, every one of them for an image the builder never scans.
  //
  // The entry below targets an image absent from this run's scanned set. It is neither matched nor
  // unmatched: it is out of scope, and the run has nothing to say about it.
  const g8allow = entry({ image: '^docker\\\\.io/library/redis:8\\\\.2@sha256:bbbbbbbbbbbb', id: 'CVE-2026-1000' });
  const g8 = capture(() => gate(rep([F()]), g8allow, NOW));
  if (/UNMATCHED ENTRIES/.test(g8.out)) failures.push('(g8) an entry whose image this run did not scan must be silent, not unmatched');
  if (capture(() => gate(rep([F()]), g8allow, NOW, { checkExpiring: true })).code !== 0) failures.push('(g8) --check-expiring must exit 0 on an out-of-scope entry');

  // And the half that must NOT be traded away: the same entry, on a run that DID scan its image, is
  // still reported and still fails --check-expiring. FR-023 survives the fix (g4 is the sibling case
  // on the default scanned set; this one proves the scoping is computed, not hardcoded).
  const g9 = capture(() => gate(rep([F()], [KC, REDIS]), g8allow, NOW));
  if (!/UNMATCHED ENTRIES/.test(g9.out)) failures.push('(g9) a stale entry for an image the run DID scan must still be reported');
  if (capture(() => gate(rep([F()], [KC, REDIS]), g8allow, NOW, { checkExpiring: true })).code !== 1) failures.push('(g9) --check-expiring must still exit 1 on a genuinely stale in-scope entry');

  // (g10) A report without `generatedForImages` is a HARD ERROR, never a fallback to "all in scope".
  // A silent fallback would reintroduce item #423 the moment a producer stopped writing the field,
  // and would do it invisibly — the gate would go back to over-reporting and still exit 0.
  try {
    evaluate({ schemaVersion: 1, findings: [F()] }, g8allow, NOW);
    failures.push('(g10) a report without generatedForImages must be rejected, not treated as all-in-scope');
  } catch (e) { if (!(e instanceof GateError)) failures.push('(g10) a report without generatedForImages must throw GateError'); }

  // ── (g11) STALE: an entry whose image the REPOSITORY no longer references (item #1136) ─────────
  //
  // The item #423 scoping above silences an entry whose image this run did not scan. On a single-image
  // run that is correct. On the full sweep it is a hole: the sweep scans every image the repository
  // references, so an entry keyed to a digest the repository has moved off targets an image NOBODY
  // scans — out of scope on every run, silent until its expiry. Measured 2026-11-24: three such
  // entries (opensearch, caddy, postgres), none ever reported.
  //
  // The judge is the ENUMERATED set (infra-image-scan.mjs's enumerateImages — what `--list` prints),
  // not the scanned set, and only on a sweep. Each case goes through `staleScope` with a fake
  // enumeration, the same call main() makes with the real one — so the wiring is what is tested.
  const enumerated = (refs, unresolved = []) => () => ({ refs, unresolved });
  const run = (report, allowlist, opts = {}, refs = [KC]) =>
    capture(() => gate(report, allowlist, NOW, { ...opts, repoImages: staleScope(report, enumerated(refs)) }));
  const sweep = (findings, images = [KC]) => ({ ...rep(findings, images), scope: 'sweep' });
  const single = (findings, images = [KC]) => ({ ...rep(findings, images), scope: 'image' });

  // (g11a) the acceptance case: full sweep, entry keyed to a digest absent from the enumerated set.
  const g11a = run(sweep([F()]), g8allow);
  if (!/STALE ENTRIES/.test(g11a.out) || !/CVE-2026-1000/.test(g11a.out)) failures.push('(g11a) a sweep must report an entry whose image the repository no longer references under STALE ENTRIES');
  if (run(sweep([F()]), g8allow, { checkExpiring: true }).code !== 1) failures.push('(g11a) --check-expiring on a sweep must exit 1 on a STALE entry');
  // …and a normal sweep gate run stays advisory: reporting it MUST NOT move the exit code (FR-021).
  // (A non-blocking finding, so the only thing that could move the code is the STALE report.)
  if (run(sweep([F({ blocking: false })]), g8allow).code !== 0) failures.push('(g11a) a STALE entry on a normal (non --check-expiring) run must be advisory (exit 0)');

  // (g11b) item #423 preserved: the SAME entry on a single-image (--image) run is silent.
  const g11b = run(single([F()]), g8allow, { checkExpiring: true });
  if (/STALE ENTRIES|UNMATCHED ENTRIES/.test(g11b.out)) failures.push('(g11b) a single-image run must stay silent about an entry for an image it did not scan');
  if (g11b.code !== 0) failures.push('(g11b) --check-expiring on a single-image run must exit 0 on another image\'s entry');

  // (g11c) an entry whose digest the repository DOES reference is not stale, even when the scan
  // produced no findings for it — staleness is about the repository, not about this run's results.
  if (/STALE ENTRIES/.test(run(sweep([]), al, { checkExpiring: true }).out)) failures.push('(g11c) an entry matching an enumerated image must not be reported as STALE');
  if (run(sweep([F()]), al, { checkExpiring: true }).code !== 0) failures.push('(g11c) a sweep with every entry live and referenced must exit 0');

  // (g11d) an ABSENT report (the scan step did not run) still judges staleness: it needs only the
  // allowlist and the repository, so a broken scan must not also blind this check.
  const g11d = run({ findings: [], reportAbsent: true }, g8allow, { checkExpiring: true });
  if (g11d.code !== 1 || !/STALE ENTRIES/.test(g11d.out)) failures.push('(g11d) --check-expiring with an absent report must still fail on a STALE entry');

  // (g11e) a report that names no scope is a HARD ERROR — guessing "sweep" would flag every other
  // image's entries on a single-image run (item #423 again), guessing "single" would silently restore
  // the hole this check closes. Same reasoning as (g10).
  try { staleScope(rep([F()]), enumerated([KC])); failures.push('(g11e) a report without `scope` must be rejected'); }
  catch (e) { if (!(e instanceof GateError)) failures.push('(g11e) a report without `scope` must throw GateError'); }

  // (g11f) an incomplete enumeration (a REGISTRY_HOST-interpolated ref left unresolved) cannot judge
  // staleness — an entry for the unresolved image would be flagged falsely. Refuse, as the scanner does.
  try { staleScope(sweep([F()]), enumerated([KC], ['infrastructure-as-code/x.yaml:3'])); failures.push('(g11f) an enumeration with unresolved refs must be rejected'); }
  catch (e) { if (!(e instanceof GateError) || !/REGISTRY_HOST/.test(e.message)) failures.push('(g11f) an incomplete enumeration must throw a GateError naming REGISTRY_HOST'); }

  if (failures.length) {
    console.error('✗ check-infra-image-findings --selftest FAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('✓ check-infra-image-findings --selftest passed (fail on fixable-Critical, allowlist-suppress, fixable-High warn, unfixable warn, medium warn, clean, blank-justification reject, expiry, warning tier + unmatched + --check-expiring + the absent-report path + stale on a sweep only).');
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
      console.log(`ℹ no scan report at ${reportPath} — expiry/expired classification still runs from the allowlist, and STALE detection from the repository's image references; UNMATCHED detection is skipped (no scanner produced findings).`);
      // `reportAbsent` is what the exemption in `evaluate()` keys on. Set ONLY here, on the announced
      // ENOENT path — a report read off disk never carries it, so a real report missing
      // `generatedForImages` is still a hard error.
      report = { findings: [], reportAbsent: true };
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
  let repoImages;
  try {
    repoImages = staleScope(report);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  process.exit(gate(report, allowlist, today(), { checkExpiring, repoImages }));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
