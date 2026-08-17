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
//   3. The Playwright CONTAINER IMAGE tag in app-ci.yml must name the version pnpm-lock.yaml
//      resolves for `@playwright/test` (item #204). The tag selects the baked browser build, so a
//      half-bump does not fail the suite — it runs ZERO tests and reports no counts at all.
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
import { parse as parseYaml } from 'yaml';

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

/** The npm package whose version the Playwright container image must match. */
const PLAYWRIGHT_PACKAGE = '@playwright/test';

/** The one workflow that runs Playwright in a pinned container. */
const PLAYWRIGHT_WORKFLOW = '.forgejo/workflows/app-ci.yml';

/**
 * Every DISTINCT `@playwright/test` version `pnpm-lock.yaml` resolves to.
 *
 * The LOCKFILE, not package.json, and that is the whole point. The manifest declares `^1.36.0` and
 * was unchanged before and after the bump that broke CI — only the resolution moved, so a gate
 * reading the manifest would pass the exact PR it exists to catch.
 *
 * Reads the map's own KEYS rather than matching the name in the text, because pnpm writes compound
 * peer-suffixed keys that embed one package name inside another —
 * `'@nx/playwright@22.7.8(…)(@playwright/test@1.62.1)(…)'`. A text match finds the name in there and
 * is then only as correct as the file's indentation.
 *
 * Returns a SET rather than a single version so the caller can tell "absent" (0) from "ambiguous"
 * (>1); collapsing either to a pick is how a gate starts passing vacuously.
 */
export function collectLockfilePlaywrightVersions(root = REPO_ROOT) {
  const lockPath = join(root, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) return [];
  const lock = parseYaml(readFileSync(lockPath, 'utf8'));
  const prefix = `${PLAYWRIGHT_PACKAGE}@`;
  const versions = new Set();
  for (const key of Object.keys(lock?.packages ?? lock?.snapshots ?? {})) {
    if (!key.startsWith(prefix)) continue;
    versions.add(key.slice(prefix.length).split('(')[0]); // drop any peer suffix
  }
  return [...versions];
}

/**
 * Every Playwright container-image pin in one file's text.
 *
 * The `v` prefix and the `-noble` suffix are ANCHORS, not decoration: the tag as a whole selects the
 * baked browser build, so a `-jammy` line carrying the same number is a different image and must not
 * be read as this pin.
 *
 * Comment lines are skipped for the same reason collectPins() skips them — app-ci.yml carries heavy
 * comment prose around this block, and prose describing a past pin is prose.
 *
 * @returns {{file:string,line:number,value:string}[]}
 */
export function collectPlaywrightImagePins(text, file) {
  const location = posixLocation(file);
  const pins = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const m = line.match(/mcr\.microsoft\.com\/playwright:v(\d[\w.]*)-noble\b/);
    if (m) pins.push({ file: location, line: i + 1, value: m[1] });
  });
  return pins;
}

/**
 * The Playwright runner and its container image must name the SAME version.
 *
 * MEASURED on PR #199, 2026-08-15, and it is the nastiest shape this gate covers. A lock-file
 * maintenance PR moved `@playwright/test` 1.60.0 -> 1.62.1 while app-ci.yml kept
 * `mcr.microsoft.com/playwright:v1.60.0-noble`. The tag selects the BAKED BROWSER BUILD, so the
 * browser executable was simply not at the path the runner looked in and ZERO tests ran. The suite
 * did not fail — it produced no counts at all, which the e2e result gate caught only after a full
 * ~35-minute app-e2e cycle, and only as a generic "app-e2e failed".
 *
 * Deliberately scoped to ONE workflow rather than to PINNED_FILES: `specs/**` records the old tag as
 * a point-in-time measurement of past features, and scanning those would fail the gate on its own
 * history.
 *
 * Both halves must be present or both absent. A repo that pins the image without resolving the
 * package, or resolves the package without pinning an image, is as broken as one whose halves
 * disagree — and "found nothing to compare" is the one answer a gate must never treat as a pass.
 *
 * @returns {{file:string,line:number,problem:string}[]}
 */
export function findPlaywrightPinDrift(root = REPO_ROOT) {
  // No lockfile: not a pnpm workspace, nothing to cross-check — the same judgement findNxPinDrift
  // makes about a missing nx.json.
  if (!existsSync(join(root, 'pnpm-lock.yaml'))) return [];

  const workflowPath = join(root, PLAYWRIGHT_WORKFLOW);
  return comparePlaywrightPins(
    collectLockfilePlaywrightVersions(root),
    existsSync(workflowPath)
      ? collectPlaywrightImagePins(readFileSync(workflowPath, 'utf8'), PLAYWRIGHT_WORKFLOW)
      : [],
  );
}

/**
 * The comparison itself, kept free of the filesystem so `--selftest` can prove the gate REJECTS a
 * mismatched pair without writing anything. A gate that cannot be shown to fail is not a gate, and
 * a demonstration that needs a temp directory is one nobody runs.
 *
 * @returns {{file:string,line:number,problem:string}[]}
 */
export function comparePlaywrightPins(versions, pins) {
  if (!versions.length) {
    if (!pins.length) return []; // Playwright is not used here at all.
    return pins.map((pin) => ({
      file: pin.file,
      line: pin.line,
      problem:
        `the Playwright image is pinned to v${pin.value}-noble but the lockfile resolves no ` +
        `${PLAYWRIGHT_PACKAGE} at all — the pinned browser build has no runner to match`,
    }));
  }

  if (versions.length > 1) {
    return [{
      file: 'pnpm-lock.yaml', line: 1,
      problem:
        `${PLAYWRIGHT_PACKAGE} resolves to ${versions.length} versions (${versions.join(', ')}) — one ` +
        'image tag cannot match them all, so the pin cannot be checked. De-duplicate the resolution.',
    }];
  }

  const [resolved] = versions;
  if (!pins.length) {
    return [{
      file: PLAYWRIGHT_WORKFLOW, line: 1,
      problem:
        `the lockfile resolves ${PLAYWRIGHT_PACKAGE} ${resolved} but this workflow pins no ` +
        'mcr.microsoft.com/playwright:v<version>-noble image — found no pin to check, which is not ' +
        'the same as finding an agreeing one. If the tag moved or changed variant, update this gate ' +
        'at the cause rather than letting it pass vacuously.',
    }];
  }

  return pins
    .filter((pin) => pin.value !== resolved)
    .map((pin) => ({
      file: pin.file,
      line: pin.line,
      problem:
        `Playwright image v${pin.value}-noble disagrees with the ${resolved} that pnpm-lock.yaml ` +
        `resolves for ${PLAYWRIGHT_PACKAGE}. The image tag selects the baked browser build, so the ` +
        'runner looks for an executable the image does not carry and ZERO tests run — the suite ' +
        'reports no counts rather than failures. Move both halves together.',
    }));
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
  findings.push(...findPlaywrightPinDrift(root));
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
    console.error('\nEvery Node pin must satisfy package.json `engines.node`, the pnpm version is single-sourced by `packageManager`, and the Playwright image tag must name the version pnpm-lock.yaml resolves.');
    process.exit(1);
  }
  console.log('✓ toolchain-consistency gate passed (every Node pin satisfies engines.node; pnpm is single-sourced; nx agrees with nx.json installation.version; the Playwright image tag matches the lockfile)');
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

  // The Playwright pair (item #204). The case that matters is the MISMATCH: everything else here
  // can pass while the comparison is disabled, so a demonstration that the gate can FAIL is the
  // only one worth running in CI.
  const image = (v) => `            mcr.microsoft.com/playwright:v${v}-noble \\`;
  const pinsFor = (...vs) => collectPlaywrightImagePins(vs.map(image).join('\n'), 'app-ci.yml');

  const one = pinsFor('1.62.1');
  t('a playwright image pin is extracted', one.length === 1 && one[0].value === '1.62.1');
  t('BOTH occurrences are extracted', pinsFor('1.62.1', '1.60.0').length === 2);
  t('a COMMENTED image line is not a pin', collectPlaywrightImagePins(`      # ${image('1.60.0')}`, 'x.yml').length === 0);
  t('a -jammy variant is not the -noble pin', collectPlaywrightImagePins(image('1.62.1').replace('-noble', '-jammy'), 'x.yml').length === 0);

  t('an agreeing pair is clean', comparePlaywrightPins(['1.62.1'], pinsFor('1.62.1', '1.62.1')).length === 0);
  t('THE BUG: a drifted image tag is REJECTED', comparePlaywrightPins(['1.62.1'], pinsFor('1.60.0', '1.60.0')).length === 2);
  t('a PARTIAL bump is REJECTED', comparePlaywrightPins(['1.62.1'], pinsFor('1.62.1', '1.60.0')).length === 1);
  t('no pin at all is REJECTED, not passed vacuously', comparePlaywrightPins(['1.62.1'], []).length === 1);
  t('an ambiguous resolution is REJECTED', comparePlaywrightPins(['1.62.1', '1.60.0'], pinsFor('1.62.1')).length === 1);
  t('neither half present is not drift', comparePlaywrightPins([], []).length === 0);

  if (fails.length) {
    console.error('✗ toolchain-consistency --selftest FAILED:\n  - ' + fails.join('\n  - '));
    process.exit(1);
  }
  console.log('✓ toolchain-consistency --selftest passed (floor comparison, pin extraction, comment immunity, Playwright drift rejection)');
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--selftest');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: check-toolchain-consistency.mjs [--selftest]`);
  process.exit(2);
}
if (args.includes('--selftest')) selftest();
else runScan();
