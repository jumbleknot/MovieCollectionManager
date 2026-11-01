#!/usr/bin/env node
// Item #776 — a pull request must not move a package INTO a known advisory, in any scope.
//
// THE FAILURE THIS EXISTS FOR (measured 2026-10-17, spec 081 US3 PR 3b, #774). `nx@23.3.0` pins
// `undici: 7.29.0` exactly. Before that bump the lockfile's only undici 7.x was 7.29.1, pulled in by
// `@module-federation/dts-plugin`, which nx 23's tree no longer reaches. So the bump re-resolved undici
// DOWN to 7.29.0 — ten advisories, two High, that 7.29.1 fixes. `sast-scan --only pnpm-audit` reported
// all ten as `pnpm-audit/dev`, which never blocks, and the gate stayed green. The agent caught it only
// by diffing the lockfile by hand.
//
// TWO GAPS, AND THIS CLOSES THE FIRST. (1) Nothing compared a package's resolution BEFORE and AFTER a
// change, so a downgrade read exactly like any other version. (2) Dev-scope findings never block. The
// second is a policy, recorded in docs/runbooks/sast-scanning.md; this check does not change it. It
// asks a narrower question that has no policy answer: did THIS change make an advisory apply to a
// package that it did not apply to before? That is never an acceptable side effect of an upgrade, in
// any scope — the dev tree runs in CI jobs that hold the remote-cache token.
//
// THE RULE, PER LOCKFILE AND PER ADVISORY:
//   - the package was resolved at the BASE, and NONE of its base versions is inside the advisory's
//     vulnerable range — the package was clean for this advisory;
//   - the HEAD resolves a version that IS inside the range, and that version is new to the lockfile.
// A package that was already exposed is not a regression (the existing gate and allowlist own it), and
// a package that is new to the lockfile is not a "change from" anything (it is an ordinary finding).
// The vulnerable range comes from the advisory itself, so "the old version was clean" is a fact about
// the advisory data, not an inference from version order — a sideways move into a range blocks too.
//
// INPUT, NOT A SECOND SCAN. The head's advisories are the pnpm-audit native report sast-scan.mjs has
// already written (security/sast/reports/pnpm-audit-native.json, one audit per committed lockfile), so
// this costs no extra registry round-trip and cannot disagree with the report the gate read. The base
// lockfiles come from git. An allowlist entry that suppresses the finding in the main gate suppresses it
// here too (same loader, same matcher, same expiry rule): accepting a version is one decision, not two.
//
// FAIL-CLOSED. A missing native report, an unreadable lockfile, or a vulnerable range this parser does
// not understand exits non-zero with the reason. A range it cannot read is a range it cannot judge.
//
// Usage:
//   node scripts/check-dependency-downgrade.mjs --base origin/main
//   node scripts/check-dependency-downgrade.mjs --base <ref> --native <path> --allowlist <path>
//
// Exit codes: 0 no regression · 1 regression found, or an input could not be read · 2 usage error.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgvError, dieOnArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';
import { evaluate, loadAllowlist } from './check-sast-findings.mjs';
import { pnpmAdvisoryId, pnpmFindingLocation } from './sast-scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_NATIVE = resolve(REPO_ROOT, 'security/sast/reports/pnpm-audit-native.json');
const DEFAULT_ALLOWLIST = resolve(REPO_ROOT, 'security/sast/allowlist.yaml');

const USAGE = `usage: node scripts/check-dependency-downgrade.mjs --base <git-ref> [--native <path>] [--allowlist <path>]

Fails when the working tree's pnpm lockfiles resolve a package INTO an advisory's vulnerable range
that none of its versions at <git-ref> was in (item #776). Reads the advisories from sast-scan.mjs's
pnpm-audit native report, so run it after the scan.`;

export class DowngradeCheckError extends Error {}

// ── npm advisory ranges ────────────────────────────────────────────────────────────────────────────
//
// No `semver` dependency: the root workspace does not declare one, and adding it would move the
// lockfile — which is the very surface this check judges. Advisory ranges use a small, regular subset
// of the grammar: comparators (`<`, `<=`, `>`, `>=`, `=`), a space for AND, `||` for OR, and the
// occasional hyphen range or wildcard. Anything else throws (see FAIL-CLOSED above).

const VERSION_RE = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a version (or a partial one, as ranges write them). Missing / wildcard parts are null. */
function parseLoose(text) {
  const m = VERSION_RE.exec(String(text).trim());
  if (!m) return null;
  const part = (p) => (p === undefined || /^[xX*]$/.test(p) ? null : Number(p));
  return { major: Number(m[1]), minor: part(m[2]), patch: part(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

function comparePre(a, b) {
  // A release outranks any of its prereleases; otherwise compare identifiers left to right.
  if (!a.length || !b.length) return (b.length ? 1 : 0) - (a.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const na = /^\d+$/.test(a[i]);
    const nb = /^\d+$/.test(b[i]);
    if (na && nb && Number(a[i]) !== Number(b[i])) return Number(a[i]) - Number(b[i]);
    if (na !== nb) return na ? -1 : 1;
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Compare two FULL versions. */
export function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseLoose(a) : a;
  const vb = typeof b === 'string' ? parseLoose(b) : b;
  for (const k of ['major', 'minor', 'patch']) {
    const d = (va[k] ?? 0) - (vb[k] ?? 0);
    if (d) return d;
  }
  return comparePre(va.pre, vb.pre);
}

/** The first version ABOVE every version a partial `x.y` (or `x`) names — `<=1.2` means `<1.3.0`. */
function bumpPartial(v) {
  if (v.minor === null) return { major: v.major + 1, minor: 0, patch: 0, pre: [] };
  return { major: v.major, minor: v.minor + 1, patch: 0, pre: [] };
}

const full = (v) => ({ major: v.major, minor: v.minor ?? 0, patch: v.patch ?? 0, pre: v.pre });

/** One comparator → a predicate over a full version. */
function comparator(token, range) {
  const m = /^(<=|>=|<|>|=)?(.+)$/.exec(token);
  const v = parseLoose(m?.[2] ?? '');
  if (!m || !v) throw new DowngradeCheckError(`cannot parse comparator "${token}" in vulnerable range "${range}"`);
  const op = m[1] ?? '=';
  const partial = v.minor === null || v.patch === null;
  const lo = full(v);
  const hi = partial ? bumpPartial(v) : null; // exclusive upper bound of what a partial version names
  switch (op) {
    case '<': return (x) => compareVersions(x, lo) < 0;
    case '>=': return (x) => compareVersions(x, lo) >= 0;
    case '<=': return partial ? (x) => compareVersions(x, hi) < 0 : (x) => compareVersions(x, lo) <= 0;
    case '>': return partial ? (x) => compareVersions(x, hi) >= 0 : (x) => compareVersions(x, lo) > 0;
    default: return partial
      ? (x) => compareVersions(x, lo) >= 0 && compareVersions(x, hi) < 0
      : (x) => compareVersions(x, lo) === 0;
  }
}

/** Compile an npm vulnerable-version range into a predicate. Throws on anything it does not understand. */
export function compileRange(range) {
  const text = String(range ?? '').trim();
  const sets = text.split('||').map((s) => s.trim());
  const preds = sets.map((set) => {
    if (set === '' || set === '*' || /^[xX]$/.test(set)) return () => true;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
    if (hyphen) {
      const ge = comparator(`>=${hyphen[1]}`, text);
      const le = comparator(`<=${hyphen[2]}`, text);
      return (x) => ge(x) && le(x);
    }
    const parts = set.split(/\s+/).map((t) => comparator(t, text));
    return (x) => parts.every((p) => p(x));
  });
  return (version) => {
    const v = parseLoose(version);
    if (!v || v.minor === null || v.patch === null) {
      throw new DowngradeCheckError(`cannot judge "${version}" against "${text}": not a full version`);
    }
    return preds.some((p) => p(v));
  };
}

// ── lockfiles ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Every resolved `name@version` in a pnpm lockfile's `packages:` sections, as Map<name, Set<version>>.
 *
 * Read line by line rather than through a YAML parse, because a pnpm 11+ lockfile is TWO YAML
 * documents (the packageManager's own environment, then the workspace) and the keys are all that is
 * needed. `packages:` keys carry no peer suffix; `snapshots:` keys do, and are deliberately not read.
 */
export function resolvedVersions(lockText) {
  const out = new Map();
  let inPackages = false;
  for (const line of String(lockText).split(/\r?\n/)) {
    if (/^\S/.test(line)) { inPackages = /^packages:\s*$/.test(line); continue; }
    if (!inPackages) continue;
    const m = /^ {2}'?((?:@[^@/\s']+\/)?[^@\s']+)@([^(':\s]+)'?:\s*$/.exec(line);
    if (!m) continue;
    if (!out.has(m[1])) out.set(m[1], new Set());
    out.get(m[1]).add(m[2]);
  }
  return out;
}

// ── the rule ───────────────────────────────────────────────────────────────────────────────────────

/**
 * PURE. Every advisory this change newly makes applicable, per the rule in the header.
 *
 * @param {object} args
 * @param {Record<string, object>} args.natives  lockfile path → `pnpm audit --json` of the HEAD
 * @param {(lockfile: string) => string|null} args.baseLock  base lockfile text, or null if it did not exist
 * @param {(lockfile: string) => string} args.headLock  head lockfile text
 * @returns {Array<{lockfile, workspace, name, baseVersions, version, id, severity, range, patched, location}>}
 */
export function findRegressions({ natives, baseLock, headLock }) {
  const regressions = [];
  for (const [lockfile, audit] of Object.entries(natives ?? {})) {
    const baseText = baseLock(lockfile);
    if (baseText === null) continue; // a lockfile new in this change has no "before" to regress from
    const base = resolvedVersions(baseText);
    const head = resolvedVersions(headLock(lockfile));
    const workspace = dirname(lockfile);
    for (const [key, adv] of Object.entries(audit?.advisories ?? {})) {
      const name = adv.module_name;
      const range = adv.vulnerable_versions;
      const baseVersions = [...(base.get(name) ?? [])];
      if (!baseVersions.length) continue; // new to the lockfile: an ordinary finding, not a change
      const inRange = compileRange(range);
      if (baseVersions.some((v) => inRange(v))) continue; // already exposed at the base: not a regression
      const affected = new Set((adv.findings ?? []).map((f) => f.version).filter(Boolean));
      // Every base version is outside the range (above), so any affected version here is new to the lockfile.
      for (const version of [...affected].sort(compareVersions)) {
        if (!head.get(name)?.has(version) || !inRange(version)) continue;
        regressions.push({
          lockfile, workspace, name, baseVersions: baseVersions.sort(compareVersions), version,
          id: pnpmAdvisoryId(adv, key), severity: String(adv.severity ?? 'unknown'), range: String(range),
          patched: adv.patched_versions ? String(adv.patched_versions) : null,
          location: pnpmFindingLocation(workspace, name, version),
        });
      }
    }
  }
  return regressions;
}

/** Split regressions into those an unexpired allowlist entry accepts, and those it does not. */
export function applyAllowlist(regressions, allowlist, now) {
  const asFindings = regressions.map((r) => ({ ...r, scanner: 'pnpm-audit', kind: 'sca', blocking: true }));
  const { failures, suppressed } = evaluate({ findings: asFindings, generatedAtScope: 'changed' }, allowlist, now);
  return { failures, suppressed };
}

export function formatRegression(r) {
  return (
    `${r.location}: ${r.name} ${r.baseVersions.join(', ')} -> ${r.version} enters ${r.id} ` +
    `(${r.severity}; vulnerable ${r.range}${r.patched ? `; fixed ${r.patched}` : ''}) [${r.lockfile}]`
  );
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────

function gitShow(ref, path) {
  const r = spawnSync('git', ['show', `${ref}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status === 0) return r.stdout;
  if (/does not exist|exists on disk, but not in/.test(r.stderr ?? '')) return null;
  throw new DowngradeCheckError(`git show ${ref}:${path} failed: ${(r.stderr ?? '').trim().slice(-300)}`);
}

export function main(argv = process.argv.slice(2)) {
  if (wantsHelp(argv)) { console.log(USAGE); return 0; }
  const { values } = partitionArgsWithValues(argv, { withValues: ['--base', '--native', '--allowlist'], usage: USAGE });
  const base = values.get('--base');
  if (!base) throw new ArgvError(`--base <git-ref> is required\n\n${USAGE}`);
  const nativePath = resolve(values.get('--native') ?? DEFAULT_NATIVE);

  let natives;
  try {
    natives = JSON.parse(readFileSync(nativePath, 'utf8'));
  } catch (e) {
    throw new DowngradeCheckError(`cannot read the pnpm-audit native report at ${nativePath} — run sast-scan.mjs first (${e.message})`);
  }
  if (!Object.keys(natives ?? {}).length) {
    throw new DowngradeCheckError(`${nativePath} audits no lockfile — refusing to report "no regression" from an empty input`);
  }

  const regressions = findRegressions({
    natives,
    baseLock: (lockfile) => gitShow(base, lockfile),
    headLock: (lockfile) => readFileSync(resolve(REPO_ROOT, lockfile), 'utf8'),
  });
  const allowlist = loadAllowlist(resolve(values.get('--allowlist') ?? DEFAULT_ALLOWLIST));
  const { failures, suppressed } = applyAllowlist(regressions, allowlist);

  for (const r of suppressed) console.log(`accepted by allowlist: ${formatRegression(r)}`);
  if (failures.length) {
    console.error(`✗ ${failures.length} package resolution(s) moved INTO a known advisory relative to ${base} (item #776):`);
    for (const r of failures) console.error(`  ${formatRegression(r)}`);
    console.error(
      '\nEach package above was clean for that advisory at the base, and this change resolves it to an affected\n' +
        'version — usually a dependency that pins an older release. Restore the clean resolution (a pnpm override\n' +
        'floor such as `undici@>=7.0.0 <7.29.1: ">=7.29.1 <8"`), or record an operator-approved allowlist entry.\n' +
        'This blocks in every scope, dev included: see docs/runbooks/sast-scanning.md.',
    );
    return 1;
  }
  console.log(`✓ no package resolution moved into a known advisory relative to ${base} (${Object.keys(natives).length} lockfile(s) checked).`);
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    if (e instanceof ArgvError) dieOnArgvError(e);
    console.error(`✗ check-dependency-downgrade: ${e.message}`);
    process.exitCode = 1;
  }
}
