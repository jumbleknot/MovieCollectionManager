#!/usr/bin/env node
// Toolchain-consistency gate — every Node/pnpm pin in the repo must agree.
//
// WHY THIS EXISTS (measured, 2026-07-26). The pnpm 10.33.0 → 11.x bump broke CI twice, both times
// from a fact that was sitting statically in the files:
//
//   1. pnpm 11 declares `engines.node >= 22.13`, but `app-ci` pinned `node-version: 20` in FOUR
//      jobs. `pnpm install` failed outright; `affected` and `mc-service-checks` went red. Cost ~an
//      hour of queue-plus-run to learn something a one-second check knows.
//   2. The pnpm version was pinned in FOUR places (package.json `packageManager`, cd-deploy's
//      `pnpm/action-setup` `version:`, and BOTH stages of frontend/mcm-app/Dockerfile). A bump to
//      one left the others behind — and because `prod-apk` is non-blocking, that breakage would
//      have shipped with nothing gating it.
//
// On its very first run this gate also caught a THIRD instance the humans had already missed:
// `cd-deploy.yml` `build-deploy` — the job that builds, pushes and deploys all six prod images —
// was still on `node-version: 20` after the bump. The next production deploy would have failed at
// `pnpm install`. That is the whole case for the gate: this class of bug is invisible to review and
// obvious to a parser.
//
// THE RULES
//   1. Every Node pin (workflow `node-version:`, Dockerfile `FROM node:<v>`) must satisfy the
//      repo's declared floor, root package.json `engines.node`. That floor is what makes the pnpm
//      requirement checkable WITHOUT a network call or a hardcoded pnpm→node table that would rot.
//      Raise the floor when the package manager's own `engines` rises.
//   2. The pnpm version is SINGLE-SOURCED by `packageManager`. Any other place naming a pnpm
//      version must name the SAME one. `pnpm/action-setup` with no `version:` is the preferred
//      form — it reads `packageManager` — and is always accepted.
//
// Deliberately NOT checked: that a pin is the newest available. This gate is about internal
// agreement, which is offline-checkable and deterministic; "is there a newer Node" is Renovate's
// job and needs the network.
//
// Usage:
//   node scripts/check-toolchain-consistency.mjs             # scan; exit 0 clean / 1 drift
//   node scripts/check-toolchain-consistency.mjs --selftest  # prove detection; exit 0/1
//   node scripts/check-toolchain-consistency.mjs --dir <d>   # scan a different repo root (tests)
//
// Exit codes: 0 clean · 1 drift found / selftest broken · 2 bad args or unreadable input.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files that may pin a Node or pnpm version. Globs are avoided — an explicit list is auditable. */
export const PINNED_FILES = [
  '.forgejo/workflows',                    // directory: every *.yml inside
  '.devcontainer/toolchain.Dockerfile',
  'frontend/mcm-app/Dockerfile',
];

/** `20` → [20,0,0] · `24.14.1` → [24,14,1] · `22.13` → [22,13,0]. Non-numeric parts are rejected. */
export function parseVersion(v) {
  const parts = String(v).trim().split('.');
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) return null;
  const [a = 0, b = 0, c = 0] = parts.map(Number);
  return [a, b, c];
}

/** Compare two parsed versions. Returns <0, 0, >0. */
export function compareVersions(x, y) {
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * Does `pin` satisfy a `>=X[.Y[.Z]]` floor?
 *
 * Only the `>=` form is understood, on purpose: it is the only shape a toolchain floor needs, and a
 * partial semver implementation that silently mis-handles `^`/`~`/ranges would be worse than one
 * that refuses them out loud.
 */
export function satisfiesFloor(pin, floor) {
  const m = String(floor).trim().match(/^>=\s*(\d+(?:\.\d+){0,2})$/);
  if (!m) throw new Error(`engines.node must be a plain ">=X.Y.Z" floor, got ${JSON.stringify(floor)}`);
  const p = parseVersion(pin);
  const f = parseVersion(m[1]);
  if (!p) return null; // unparseable pin (e.g. `lts/*`) — reported separately, never silently passed
  return compareVersions(p, f) >= 0;
}

/** Collect every Node/pnpm pin from one file's text. */
export function collectPins(text, file) {
  const pins = [];
  const lines = text.split('\n');
  // Normalized HERE as well as in filesToScan, because this is where a finding's `file` is actually
  // constructed — a caller passing a platform path must not be able to smuggle a backslash into a
  // report (see posixLocation).
  const location = posixLocation(file);
  lines.forEach((line, i) => {
    const at = { file: location, line: i + 1 };
    // Skip comment lines so prose describing a past pin (there is plenty) is never read as a pin.
    if (/^\s*#/.test(line)) return;

    let m = line.match(/node-version:\s*'?"?([\w.*/-]+)'?"?/);
    if (m) pins.push({ ...at, kind: 'node', value: m[1], how: 'node-version' });

    m = line.match(/^\s*FROM\s+node:([\w.-]+)/i);
    if (m) pins.push({ ...at, kind: 'node', value: m[1].split('-')[0], how: 'FROM node:' });

    m = line.match(/corepack\s+prepare\s+pnpm@([\w.-]+)/);
    if (m) pins.push({ ...at, kind: 'pnpm', value: m[1], how: 'corepack prepare' });

    // `pnpm/action-setup` version, written inline as `with: { version: X }` or on its own line.
    m = line.match(/^\s*(?:with:\s*\{\s*)?version:\s*'?"?(\d[\w.-]*)'?"?/);
    if (m && /version:/.test(line) && !/node-version/.test(line)) {
      pins.push({ ...at, kind: 'pnpm', value: m[1], how: 'action-setup version' });
    }
  });
  return pins;
}

/**
 * A finding's location, in a form that does not depend on the operating system it was produced on.
 *
 * `join()` emits the platform separator, so the same finding read `.forgejo/workflows/app-ci.yml` on
 * Linux and `.forgejo\workflows\app-ci.yml` on Windows — and the test pinning that output failed on
 * Windows for a reason no developer caused. A suite that goes red for nobody's fault is a suite
 * people learn to ignore.
 *
 * This is deliberately a SOURCE fix rather than a relaxed assertion. The findings output is a report
 * a human reads and pastes into an issue, so a stable representation is worth more than the
 * platform's native one — the test was asserting the more useful contract, and the source moves to
 * meet it. Normalizing HERE, where the location is built, rather than at the print site, is what
 * stops the next reporting path re-introducing the split.
 */
export const posixLocation = (p) => String(p).split('\\').join('/');

function filesToScan(root) {
  const out = [];
  for (const entry of PINNED_FILES) {
    const p = join(root, entry);
    if (!existsSync(p)) continue;
    try {
      const names = readdirSync(p); // throws ENOTDIR for a file
      for (const n of names) if (/\.ya?ml$/.test(n)) out.push(posixLocation(join(entry, n)));
    } catch {
      out.push(posixLocation(entry));
    }
  }
  return out;
}

/**
 * The Nx version is pinned in TWO tracked places and they must agree.
 *
 * MEASURED 2026-08-01, and it silently defeated a SECURITY update. Renovate bumped
 * `devDependencies.nx` to 22.7.2 (a `[security]` bump) and merged green — but `nx.json`
 * `installation.version` still said 22.6.3. That second pin is the one that decides what actually
 * runs: with an `installation` block present, the Nx wrapper resolves the CLI from
 * `.nx/installation`, which is **gitignored**, so `nx.json` is the only tracked source of truth for
 * the version every `pnpm nx` invocation — CI included — really executes. `pnpm nx --version`
 * reported `Local: v22.6.3` on a tree whose package.json claimed 22.7.2.
 *
 * That is the exact failure this whole gate exists for: one version, several files, a bump applied
 * to a subset, invisible to review and obvious to a parser. It is worse here than for Node or pnpm,
 * because the drift does not break the build — it just quietly keeps running the version the bump
 * was supposed to remove, and a security advisory stays open while the PR that closes it is merged.
 *
 * @returns {{file:string,line:number,problem:string}[]}
 */
export function findNxPinDrift(root = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const nxJsonPath = join(root, 'nx.json');
  // No nx.json at all: not an Nx workspace, nothing to cross-check. (In THIS repo its absence would
  // break far louder things than a version gate.)
  if (!existsSync(nxJsonPath)) return [];
  const nxJsonText = readFileSync(nxJsonPath, 'utf8');
  const nxJson = JSON.parse(nxJsonText);

  const declared = pkg.devDependencies?.nx ?? pkg.dependencies?.nx ?? null;
  const installed = nxJson.installation?.version ?? null;

  // No `installation` block means the wrapper is not in use and package.json alone decides. Nothing
  // to disagree with, so this is not drift — but do not silently pass a MISSING nx either.
  if (installed === null) return [];
  if (declared === null) {
    return [{
      file: 'package.json', line: 1,
      problem: `nx.json pins installation.version ${installed} but package.json declares no nx dependency — the wrapper version would go unchecked`,
    }];
  }

  // Only exact pins are compared. A range (^/~/x) cannot be equal to a single version, and quietly
  // treating "^22.7.2 covers 22.6.3" as agreement would reinstate exactly the bug above.
  const exact = /^\d+\.\d+\.\d+$/;
  if (!exact.test(declared)) {
    return [{
      file: 'package.json', line: 1,
      problem: `nx must be pinned exactly (got ${JSON.stringify(declared)}) so it can be compared with nx.json installation.version ${installed}`,
    }];
  }
  if (declared === installed) return [];

  const line = nxJsonText.split('\n').findIndex((l) => l.includes(`"${installed}"`)) + 1;
  return [{
    file: 'nx.json', line: line || 1,
    problem:
      `nx.json installation.version ${installed} disagrees with package.json nx ${declared} — the Nx WRAPPER wins, ` +
      `so every \`pnpm nx\` (and all of CI) actually runs ${installed}. Bump both together; a package.json-only ` +
      `bump does not take effect, which has already defeated a security update.`,
  }];
}

/** @returns {{file:string,line:number,problem:string}[]} */
export function findDrift(root = REPO_ROOT) {
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const findings = [];

  const floor = pkg.engines?.node;
  if (!floor) {
    return [{
      file: 'package.json', line: 1,
      problem: 'no `engines.node` floor declared — the gate needs it to check every Node pin. Set it to the minimum the pinned packageManager requires.',
    }];
  }

  const pmMatch = String(pkg.packageManager ?? '').match(/^pnpm@(\d[\w.-]*)$/);
  if (!pmMatch) {
    return [{ file: 'package.json', line: 1, problem: `packageManager must be "pnpm@<version>", got ${JSON.stringify(pkg.packageManager)}` }];
  }
  const pnpmVersion = pmMatch[1];

  for (const rel of filesToScan(root)) {
    const text = readFileSync(join(root, rel), 'utf8');
    for (const pin of collectPins(text, rel)) {
      if (pin.kind === 'node') {
        const ok = satisfiesFloor(pin.value, floor);
        if (ok === null) {
          findings.push({ file: pin.file, line: pin.line, problem: `Node pin "${pin.value}" (${pin.how}) is not a plain version — pin an explicit one so it can be checked against engines.node (${floor})` });
        } else if (!ok) {
          findings.push({ file: pin.file, line: pin.line, problem: `Node ${pin.value} (${pin.how}) is BELOW the repo floor engines.node ${floor} — pnpm ${pnpmVersion} will refuse to run` });
        }
      } else if (pin.value !== pnpmVersion) {
        findings.push({ file: pin.file, line: pin.line, problem: `pnpm ${pin.value} (${pin.how}) disagrees with packageManager pnpm@${pnpmVersion} — single-source it (drop the explicit version, or match it)` });
      }
    }
  }

  findings.push(...findNxPinDrift(root));
  return findings;
}

function runScan() {
  let findings;
  try {
    findings = findDrift();
  } catch (e) {
    console.error(`✗ toolchain-consistency gate could not run: ${e.message}`);
    process.exit(2);
  }
  if (findings.length) {
    console.error(`✗ toolchain-consistency gate FAILED: ${findings.length} pin(s) disagree:`);
    for (const f of findings) console.error(`  ${f.file}:${f.line} — ${f.problem}`);
    console.error('\nEvery Node pin must satisfy package.json `engines.node`, and the pnpm version is single-sourced by `packageManager`.');
    process.exit(1);
  }
  console.log('✓ toolchain-consistency gate passed (every Node pin satisfies engines.node; pnpm is single-sourced; nx agrees with nx.json installation.version)');
}

function selftest() {
  const fails = [];
  const t = (label, cond) => { if (!cond) fails.push(label); };

  t('parseVersion pads', JSON.stringify(parseVersion('22.13')) === '[22,13,0]');
  t('parseVersion rejects junk', parseVersion('lts/*') === null);
  t('20 does NOT satisfy >=22.13', satisfiesFloor('20', '>=22.13') === false);
  t('22.13 satisfies >=22.13', satisfiesFloor('22.13', '>=22.13') === true);
  t('24.14.1 satisfies >=22.13', satisfiesFloor('24.14.1', '>=22.13') === true);
  t('24 (major only) satisfies >=22.13', satisfiesFloor('24', '>=22.13') === true);
  t('22.12 does NOT satisfy >=22.13', satisfiesFloor('22.12', '>=22.13') === false);
  t('unparseable pin returns null', satisfiesFloor('lts/*', '>=22.13') === null);
  let threw = false;
  try { satisfiesFloor('20', '^22'); } catch { threw = true; }
  t('a non->= floor is refused loudly', threw);

  // The exact shapes that broke CI.
  const wf = collectPins('        with: { node-version: 20, cache: pnpm }', 'x.yml');
  t('inline node-version parsed', wf.length === 1 && wf[0].kind === 'node' && wf[0].value === '20');
  const df = collectPins('FROM node:24.14.1-alpine3.23 AS builder', 'Dockerfile');
  t('FROM node: parsed, suffix stripped', df.length === 1 && df[0].value === '24.14.1');
  const cp = collectPins('RUN corepack enable && corepack prepare pnpm@11.17.0 --activate', 'Dockerfile');
  t('corepack pnpm pin parsed', cp.length === 1 && cp[0].kind === 'pnpm' && cp[0].value === '11.17.0');
  const as = collectPins('        with: { version: 10.33.0 }', 'x.yml');
  t('action-setup version parsed', as.length === 1 && as[0].kind === 'pnpm' && as[0].value === '10.33.0');
  t('a COMMENT naming a pin is ignored', collectPins('      # pin `version: 10.33.0` explicitly, which…', 'x.yml').length === 0);

  if (fails.length) {
    console.error('✗ toolchain-consistency --selftest FAILED:\n  - ' + fails.join('\n  - '));
    process.exit(1);
  }
  console.log('✓ toolchain-consistency --selftest passed (floor comparison, pin extraction, comment immunity)');
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--selftest');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: check-toolchain-consistency.mjs [--selftest]`);
  process.exit(2);
}
if (args.includes('--selftest')) selftest();
else runScan();
