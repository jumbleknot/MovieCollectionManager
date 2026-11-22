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
//      version must name the SAME one. The two installers CI uses both read `packageManager` and name
//      no version: scripts/install-pnpm.sh in container jobs, `pnpm/action-setup` with no `version:`
//      on the `kvm:host` runner (which installer goes where: renovate-workflow.guard.test.mjs).
//   2b. `packageManager` itself is declared EXACTLY ONCE, in the ROOT manifest (item #286). This is
//      the one rule that does not offer "or match it": pnpm switches to the field of the WORKSPACE
//      ROOT it operates on, so a second one silently WINS in a nested workspace (its own
//      pnpm-workspace.yaml, e.g. tools/openwiki-generator; under corepack, in ANY directory), and
//      Renovate's npm manager maintains it as a SEPARATE dependency on its own track. Measured —
//      frontend/mcm-app/package.json held a copy that the migration wrote as pnpm@10.33.0 alongside
//      the root's, which Renovate then carried to 10.34.5 while the root went to 11.22.0. An
//      agreeing copy is one bot PR from drifting; removal is the only state that cannot come apart.
//   3. The Playwright CONTAINER IMAGE tag in app-ci.yml must name the version pnpm-lock.yaml
//      resolves for `@playwright/test` (item #204). The tag selects the baked browser build, so a
//      half-bump does not fail the suite — it runs ZERO tests and reports no counts at all.
//   4. ONE Node major across `FROM node:`, every `node-version:` and the Playwright image (item
//      #992). Renovate proposes the major on two separate tracks and each half passes rule 1 alone;
//      the Playwright image picks its own Node, so app-ci passes `EXPECTED_NODE_MAJOR` into it and
//      scripts/run-playwright-in-image.sh checks the image's real Node against it at run time.
//      A job that runs Node with NO setup-node pins nothing and would be invisible to that
//      comparison, so every Node-running job must have a pinned setup-node before its first Node
//      use (scripts/install-pnpm.sh excepted) — else it runs on the runner's implicit Node, the
//      `ubuntu-latest` image's node:22-bookworm or the kvm host's own (collectImplicitNodeJobs).
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
import { parseAllDocuments, parseDocument, LineCounter } from 'yaml';

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
  // WHICH ACTION the current `with:` block belongs to. Item #307 made this necessary: the pnpm
  // matcher below read ANY bare `version:` key, which was true only while `pnpm/action-setup` was
  // the sole action here taking one. `astral-sh/setup-uv` also takes `version:`, and pinning uv
  // (five sites) made the gate report five pnpm pins of `0.12.7` — a gate failing on a premise that
  // had quietly stopped being true, which is worse than not checking, because it is loud and wrong.
  // Narrowing it to the enclosing step is strictly stronger: it now asserts a RELATION (this
  // version belongs to pnpm/action-setup) rather than a coincidence of key names.
  let currentUses = null;
  lines.forEach((line, i) => {
    const at = { file: location, line: i + 1 };
    // Skip comment lines so prose describing a past pin (there is plenty) is never read as a pin.
    if (/^\s*#/.test(line)) return;

    // A new YAML list item is a new step, so the previous step's action no longer governs. Reset
    // BEFORE reading this line's own `uses:`, because `- uses: …` is both at once.
    if (/^\s*-\s/.test(line)) currentUses = null;
    const u = line.match(/\buses:\s*([^\s#]+)/);
    if (u) currentUses = u[1];

    let m = line.match(/node-version:\s*'?"?([\w.*/-]+)'?"?/);
    if (m) pins.push({ ...at, kind: 'node', value: m[1], how: 'node-version' });

    m = line.match(/^\s*FROM\s+node:([\w.-]+)/i);
    if (m) pins.push({ ...at, kind: 'node', value: m[1].split('-')[0], how: 'FROM node:' });

    m = line.match(/corepack\s+prepare\s+pnpm@([\w.-]+)/);
    if (m) pins.push({ ...at, kind: 'pnpm', value: m[1], how: 'corepack prepare' });

    // `pnpm/action-setup` version, written inline as `with: { version: X }` or on its own line —
    // and ONLY when the enclosing step is actually pnpm/action-setup (see currentUses above).
    // A `version:` under any other action is that action's, and a `version:` under no action at all
    // (a Dockerfile, say) is not an action-setup pin by definition. The pnpm sources that matter are
    // still covered without it: `packageManager` is the single source, and `corepack prepare pnpm@X`
    // above catches the Dockerfile pair that item #225 is about.
    m = line.match(/^\s*(?:with:\s*\{\s*)?version:\s*'?"?(\d[\w.-]*)'?"?/);
    if (m && !/node-version/.test(line) && /(^|\/)pnpm\/action-setup/.test(currentUses ?? '')) {
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

/** Dependency maps a lockstep declaration can live in. peerDependencies are ranges by design. */
const DEPENDENCY_MAPS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** True for the packages Renovate moves AS ONE UNIT and that therefore must be pinned exactly. */
export const isLockstepPackage = (name) => name === 'nx' || name.startsWith('@nx/') || name === '@playwright/test';

/**
 * The lockstep comparison itself, kept pure so the selftest can drive it without a filesystem.
 *
 * @param {{file:string,line:number,name:string,spec:string}[]} decls every lockstep declaration found
 * @param {string|null} nxVersion the root manifest's exact `nx` pin, or null when it has none
 * @returns {{file:string,line:number,problem:string}[]}
 */
export function compareLockstepDeclarations(decls, nxVersion) {
  const exact = /^\d+\.\d+\.\d+$/;
  const findings = [];
  for (const d of decls) {
    if (!exact.test(d.spec)) {
      findings.push({
        file: d.file, line: d.line,
        problem:
          `${d.name} is declared as ${JSON.stringify(d.spec)} — it must be pinned EXACTLY. Renovate's group rule ` +
          'moves it in lockstep with its partners, but lockFileMaintenance re-resolves inside a RANGE and no ' +
          'groupName applies to it, so a range lets a lockfile refresh move this one alone (PR #695: ' +
          '@playwright/test 1.63.0 -> 1.64.0 without its image, zero tests ran).',
      });
      continue;
    }
    if (d.name.startsWith('@nx/') && nxVersion && d.spec !== nxVersion) {
      findings.push({
        file: d.file, line: d.line,
        problem:
          `${d.name} ${d.spec} disagrees with nx ${nxVersion} — the Nx core and its plugins are one release and ` +
          'move together (`nx monorepo` group). Pin every @nx/* to the nx version.',
      });
    }
  }
  const playwright = [...new Set(decls.filter((d) => d.name === '@playwright/test' && exact.test(d.spec)).map((d) => d.spec))];
  if (playwright.length > 1) {
    const first = decls.find((d) => d.name === '@playwright/test');
    findings.push({
      file: first.file, line: first.line,
      problem: `@playwright/test is pinned to ${playwright.join(' and ')} across manifests — one runner, one version.`,
    });
  }
  return findings;
}

/**
 * Every package Renovate moves as one unit must be pinned EXACTLY in every manifest — and the Nx
 * plugins must equal the Nx core.
 *
 * MEASURED 2026-10-09. The `playwright pin` and `nx monorepo` group rules hold their pairs together
 * for ordinary updates only. `lockFileMaintenance` re-resolves every RANGE inside the manifest and is
 * not an update of any one package, so no groupName applies to it:
 *   - PR #695 moved `@playwright/test` (`^1.59.1`) to 1.64.0 while the app-ci image stayed on
 *     v1.63.0-noble — findPlaywrightPinDrift caught it, after ~35 minutes of app-e2e running zero tests;
 *   - `@nx/playwright` (`^22.6.3`) had already been moved to 22.7.12 by an earlier refresh, on a tree
 *     whose `nx` was 22.7.10 and `@nx/expo` 22.6.3 — three Nx versions at once, which nothing checked.
 * An exact pin leaves a refresh nothing to move, and turns the next version into an ordinary update
 * that the group rule DOES govern. This reads MANIFESTS rather than the lockfile on purpose: the
 * lockfile check fires after the drift has happened, this one makes the drift impossible.
 *
 * @returns {{file:string,line:number,problem:string}[]}
 */
export function findLockstepPinDrift(root = REPO_ROOT) {
  const decls = [];
  let nxVersion = null;
  for (const rel of ['package.json', ...collectNestedManifests(root)]) {
    const text = readFileSync(join(root, rel), 'utf8');
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      continue; // findNestedPackageManagerDrift already reports an unparseable manifest
    }
    const lines = text.split(/\r?\n/);
    for (const map of DEPENDENCY_MAPS) {
      for (const [name, spec] of Object.entries(pkg[map] ?? {})) {
        if (!isLockstepPackage(name)) continue;
        const idx = lines.findIndex((l) => l.includes(`"${name}"`));
        decls.push({ file: posixLocation(rel), line: idx === -1 ? 1 : idx + 1, name, spec: String(spec) });
        if (rel === 'package.json' && name === 'nx') nxVersion = String(spec);
      }
    }
  }
  return compareLockstepDeclarations(decls, nxVersion);
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
/**
 * The DEPENDENCY lockfile out of pnpm-lock.yaml's text.
 *
 * pnpm 12 (measured 2026-10-17, feature 081 US2) writes the file as TWO YAML documents when
 * `packageManager` pins it: an "env lockfile" first — `packageManagerDependencies` and the
 * `@pnpm/exe.*` native binaries — and the dependency lockfile LAST. A single-document parse throws
 * "Source contains multiple documents"; on the bump commit that turned this gate into `could not run`
 * (exit 2) on a lockfile pnpm itself had just written. The last document is the one read — the same
 * choice Renovate's pnpm extractor makes (`parseYaml(raw).at(-1)`) — and a single-document (pnpm 11)
 * lockfile is simply its own last document. A YAML error in ANY document still throws: a lockfile
 * that is half-parseable is not one this gate may read a pass out of.
 */
export function parseDependencyLockfile(text) {
  const docs = parseAllDocuments(text);
  const list = Array.isArray(docs) ? docs : [];
  for (const doc of list) if (doc.errors.length) throw doc.errors[0];
  return list.length ? list[list.length - 1].toJS() : null;
}

export function collectLockfilePlaywrightVersions(root = REPO_ROOT) {
  const lockPath = join(root, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) return [];
  const lock = parseDependencyLockfile(readFileSync(lockPath, 'utf8'));
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

/** Directories a manifest walk must never descend into. Installed trees are full of package.json. */
const MANIFEST_SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'target', 'dist', 'build', '.nx', '.pnpm-store',
  'coverage', 'test-results', 'playwright-report', '.expo', 'android', 'ios',
]);

/** Every package.json under `root` EXCEPT the root's own, as POSIX repo-relative paths. */
export function collectNestedManifests(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is not a manifest claim; the okf job surfaces real IO faults
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (MANIFEST_SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name === 'package.json' && rel) {
        out.push(`${rel}/package.json`);
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * `packageManager` must be declared EXACTLY ONCE, in the root manifest — item #286.
 *
 * MEASURED 2026-08-29. frontend/mcm-app/package.json carried a second copy. The npm→pnpm migration
 * (a19962b9) wrote pnpm@10.33.0 into BOTH manifests; every later bump moved the root only, so when
 * the root reached 11.22.0 the app was still on the 10.x track — Renovate had been maintaining it
 * there as a separate dependency (871d79aa: 10.33.0 → 10.34.5) and the Dependency Dashboard was
 * proposing a `pnpm to v11` MAJOR against it. This gate could not see it: it reads the root field as
 * the single source and then checks workflows and Dockerfiles, never another package.json.
 *
 * Fourth instance of the shape this file exists for (#194 nx, #204 Playwright, #225 the Dockerfile
 * corepack pins), and the only one where the duplicate lives in the same KIND of file as the source.
 *
 * THE RULE IS "DECLARED ONCE", NOT "DECLARED CONSISTENTLY", and that is deliberate — it is the one
 * place this gate does not offer "or match it". pnpm switches to the `packageManager` of the
 * WORKSPACE ROOT it operates on, so a second field silently WINS in a nested workspace (one with its
 * own pnpm-workspace.yaml — measured 2026-11-15, pnpm 12 without corepack; a member package's copy is
 * ignored, though under corepack the nearest package.json won everywhere); and an agreeing copy is one bot PR from drifting, which is exactly how this one
 * drifted a whole major. Removing it is the only state that cannot come apart again.
 *
 * @returns {{file:string,line:number,problem:string}[]}
 */
export function findNestedPackageManagerDrift(root = REPO_ROOT) {
  const rootPnpm = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager ?? '');
  const findings = [];

  for (const rel of collectNestedManifests(root)) {
    const text = readFileSync(join(root, rel), 'utf8');
    let declared;
    try {
      declared = JSON.parse(text).packageManager;
    } catch {
      // A manifest that cannot be parsed cannot be cleared, and silence would read as "no field".
      findings.push({ file: posixLocation(rel), line: 1, problem: 'package.json is not parseable JSON — the gate cannot confirm it declares no `packageManager`' });
      continue;
    }
    if (declared === undefined) continue;

    const lineIdx = text.split(/\r?\n/).findIndex((l) => /"packageManager"\s*:/.test(l));
    findings.push({
      file: posixLocation(rel),
      line: lineIdx === -1 ? 1 : lineIdx + 1,
      problem:
        `declares its own packageManager ${JSON.stringify(declared)} — the root declares ${JSON.stringify(rootPnpm)}. ` +
        'pnpm switches to this field for any nested workspace that declares it (its own ' +
        'pnpm-workspace.yaml), so this one can silently win there, and Renovate maintains it as a SEPARATE ' +
        'dependency that drifts onto its own track. Remove it — the root manifest is the single source.',
    });
  }
  return findings;
}

/** The image that SHIPS — the reference every other Node pin is compared against. */
const SHIPPED_IMAGE = 'frontend/mcm-app/Dockerfile';

/**
 * Every `-e EXPECTED_NODE_MAJOR=<n>` in a Playwright `docker run`, and every Playwright image pin
 * that has none. A step is one `run:` block: the pass-through and the image tag sit on the lines of
 * the same backslash-continued command, so the expectation is read from the step the tag is in.
 *
 * @returns {{expected:{file:string,line:number,value:string}[], missing:{file:string,line:number}[]}}
 */
export function collectPlaywrightNodeExpectations(text, file) {
  const location = posixLocation(file);
  const expected = [];
  const missing = [];
  let step = { expectation: null, images: [] };
  const close = () => {
    if (!step.expectation) missing.push(...step.images);
    step = { expectation: null, images: [] };
  };
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    if (/^\s*-\s/.test(line)) close();
    const e = line.match(/\bEXPECTED_NODE_MAJOR=(\S+?)(?=\s|\\|$)/);
    if (e) {
      step.expectation = e[1];
      expected.push({ file: location, line: i + 1, value: e[1] });
    }
    if (/mcr\.microsoft\.com\/playwright:v\d[\w.]*-noble\b/.test(line)) step.images.push({ file: location, line: i + 1 });
  });
  close();
  return { expected, missing };
}

/**
 * ONE Node major across the shipped image, every CI `setup-node`, and the Playwright E2E image —
 * item #992.
 *
 * Renovate proposes a Node major on TWO separate tracks (`major-docker-base-images` for every
 * `FROM node:` and `major-ci-actions` for every `node-version:`), and each half passes rule 1's
 * floor on its own. Merged apart, CI builds and tests on one major while the image ships another,
 * and nothing in rule 1 can see it. The Playwright image is the third party: its Node is the
 * image's choice (v1.65.0-noble moved 24 -> 26, and 26 bundles no corepack, so web-e2e ran ZERO
 * tests — PR #1013), and it is in no file this gate can read. So each Playwright `docker run`
 * passes `EXPECTED_NODE_MAJOR` into the container, scripts/run-playwright-in-image.sh refuses to
 * run when the image's real `node` disagrees, and this rule holds that literal to the same major
 * as every pin here. The static half catches a split in one second; the runtime half catches an
 * image whose Node moved under a tag.
 *
 * The reference is the SHIPPED image's major, because app-ci's setup-node exists to build what
 * that image runs; without one, the most common major is the reference.
 *
 * @returns {{file:string,line:number,problem:string}[]}
 */
export function compareNodeMajors(nodePins, expectations) {
  const majorOf = (v) => parseVersion(String(v).split('.')[0])?.[0] ?? null;
  const all = [
    ...nodePins.map((p) => ({ ...p, major: majorOf(p.value), what: `Node ${p.value} (${p.how})` })),
    ...expectations.expected.map((p) => ({ ...p, major: majorOf(p.value), what: `the Playwright image's EXPECTED_NODE_MAJOR=${p.value}` })),
  ];
  const findings = expectations.missing.map((p) => ({
    file: p.file,
    line: p.line,
    problem:
      'this Playwright docker run passes no EXPECTED_NODE_MAJOR, so the image\'s own Node is unchecked — ' +
      'the image chooses its Node (v1.65 moved to 26 with no corepack, zero tests ran, PR #1013). ' +
      'Add `-e EXPECTED_NODE_MAJOR=<the pinned Node major>` to the step.',
  }));
  const known = all.filter((p) => p.major !== null);
  if (!known.length) return findings;

  const shipped = known.find((p) => p.file === SHIPPED_IMAGE);
  let reference = shipped?.major;
  if (reference === undefined) {
    const counts = new Map();
    for (const p of known) counts.set(p.major, (counts.get(p.major) ?? 0) + 1);
    reference = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  }
  const source = shipped ? `the shipped image (${SHIPPED_IMAGE}:${shipped.line})` : 'the most common pin';
  for (const p of known) {
    if (p.major === reference) continue;
    findings.push({
      file: p.file,
      line: p.line,
      problem:
        `${p.what} is Node major ${p.major}, but ${source} is on Node major ${reference} — move the ` +
        'images, every setup-node and the Playwright image as ONE change (item #992), never as two Renovate majors',
    });
  }
  return findings;
}

/** @returns {{file:string,line:number,problem:string}[]} */
export function findNodeMajorDrift(root = REPO_ROOT, nodePins = null) {
  const pins = nodePins ?? filesToScan(root).flatMap((rel) => collectPins(readFileSync(join(root, rel), 'utf8'), rel).filter((p) => p.kind === 'node'));
  const workflowPath = join(root, PLAYWRIGHT_WORKFLOW);
  const expectations = existsSync(workflowPath)
    ? collectPlaywrightNodeExpectations(readFileSync(workflowPath, 'utf8'), PLAYWRIGHT_WORKFLOW)
    : { expected: [], missing: [] };
  return compareNodeMajors(pins, expectations);
}

/**
 * Where a job gets its Node when no setup-node runs, per runner label (docs/runbooks/Server-Setup-Runbook.md,
 * the `--label` flags on the runner's ExecStart). Used only to word the finding: the rule below holds for
 * EVERY label, because no label in this repo provides a Node the gate can read.
 */
export const RUNNER_IMPLICIT_NODE = {
  'ubuntu-latest': 'the runner container image node:22-bookworm',
  kvm: "the CI host's own Node (kvm:host)",
};

/**
 * A `run:` line that executes Node — directly, or through pnpm/npm/npx/corepack — in COMMAND position:
 * line start, after `;` `&&` `||` `|` `(` `$(` or a backtick, after a shell keyword or `VAR=x` prefixes,
 * or as the command `scripts/ci-log-step.sh <name>` wraps. Command position matters: the word `npm` in
 * an `echo "…"` sentence is prose (prod-apk has exactly that), and reading it as Node use is a gate
 * failing loudly on a false premise. Comment lines never count.
 */
const CMD_PREFIX = String.raw`(?:(?:if|then|else|elif|do|exec|time|!|env|timeout\s+\S+)\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
const NODE_CMD = String.raw`(?:node|pnpm|npx|npm|corepack)(?=\s|$|\))`;
const RUNS_NODE = new RegExp(
  String.raw`(?:(?:^|[;&|(\x60]|\$\()\s*${CMD_PREFIX}${NODE_CMD})|(?:ci-log-step\.sh\s+\S+\s+${CMD_PREFIX}${NODE_CMD})`,
);
/** The one step allowed to run before setup-node: setup-node's `cache: pnpm` needs pnpm on PATH already. */
const PNPM_BOOTSTRAP = /\bscripts\/install-pnpm\.sh\b/;

const runsNode = (run) =>
  typeof run === 'string' && run.split('\n').some((l) => !/^\s*#/.test(l) && (RUNS_NODE.test(l) || PNPM_BOOTSTRAP.test(l)));

/**
 * Rule 4's blind spot: a job that runs Node with NO setup-node pins nothing, so the major comparison above
 * never sees it — and it runs on whatever Node the runner happens to carry. Measured 2026-11-22: five
 * guardrails jobs (including `node --test scripts/__tests__`), wiki-maintain, two `changes` jobs and
 * trigger-cd ran on the `ubuntu-latest` image's Node 22 while every pin in the repo said 26, and
 * devcontainer-image ran on the host's. The gate passed, because an absent pin is not a disagreeing one.
 *
 * So: every job that runs node/pnpm/npm/npx/corepack MUST have an `actions/setup-node` step with an
 * explicit `node-version:` (whose major the comparison above then holds to the repo's), and that step
 * MUST come before the job's first Node use. The single exception is scripts/install-pnpm.sh placed
 * before it — setup-node's `cache: pnpm` runs `pnpm store path`, so pnpm must already be on PATH, and
 * once setup-node has run, pnpm's `#!/usr/bin/env node` resolves to the pinned Node.
 *
 * @returns {{file:string,line:number,problem:string}[]}
 */
export function collectImplicitNodeJobs(text, file) {
  const location = posixLocation(file);
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const jobs = doc.get('jobs', true);
  if (!jobs || !Array.isArray(jobs.items)) return [];

  const findings = [];
  for (const pair of jobs.items) {
    const id = String(pair.key?.value ?? pair.key);
    const job = pair.value?.toJSON?.() ?? null;
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const line = pair.key?.range ? lineCounter.linePos(pair.key.range[0]).line : 1;

    const setupAt = steps.findIndex((s) => /(^|\/)setup-node@/.test(String(s?.uses ?? '')));
    const firstUse = steps.findIndex((s, i) => runsNode(s?.run) && !(setupAt > i && PNPM_BOOTSTRAP.test(s.run)));
    if (firstUse === -1) continue;

    const labels = [job['runs-on']].flat().map(String);
    const implicit = labels.map((l) => RUNNER_IMPLICIT_NODE[l]).find(Boolean) ?? "the runner's own Node";
    const use = steps[firstUse].name ? `step "${steps[firstUse].name}"` : `step ${firstUse + 1}`;

    if (setupAt === -1) {
      findings.push({
        file: location, line,
        problem:
          `job \`${id}\` runs Node (${use}) with NO actions/setup-node, so it runs on ${implicit} — a Node no pin ` +
          'declares and rule 4 cannot see (item #992). Add the pinned setup-node step with the repo\'s ' +
          'node-version right after checkout (after scripts/install-pnpm.sh only if it uses `cache: pnpm`).',
      });
    } else if (steps[setupAt]?.with?.['node-version'] === undefined) {
      findings.push({
        file: location, line,
        problem: `job \`${id}\`'s setup-node names no \`node-version:\`, so the major it installs is not a pin rule 4 can check — pin it explicitly.`,
      });
    } else if (firstUse < setupAt) {
      findings.push({
        file: location, line,
        problem:
          `job \`${id}\` runs Node (${use}) BEFORE its setup-node step, so that step runs on ${implicit}. ` +
          'Move setup-node up; only scripts/install-pnpm.sh may precede it.',
      });
    }
  }
  return findings;
}

/** @returns {{file:string,line:number,problem:string}[]} */
export function findImplicitNodeJobs(root = REPO_ROOT) {
  return filesToScan(root)
    .filter((rel) => rel.startsWith('.forgejo/workflows/'))
    .flatMap((rel) => collectImplicitNodeJobs(readFileSync(join(root, rel), 'utf8'), rel));
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

  findings.push(...findNestedPackageManagerDrift(root));
  findings.push(...findNxPinDrift(root));
  findings.push(...findLockstepPinDrift(root));
  findings.push(...findPlaywrightPinDrift(root));
  findings.push(...findNodeMajorDrift(root));
  findings.push(...findImplicitNodeJobs(root));
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
    console.error('\nEvery Node pin must satisfy package.json `engines.node`, the pnpm version is single-sourced by the ROOT `packageManager` and declared nowhere else, the packages Renovate moves as one unit (nx, @nx/*, @playwright/test) are pinned exactly with @nx/* equal to nx, the Playwright image tag must name the version pnpm-lock.yaml resolves, and the Node images, every setup-node and the Playwright image (EXPECTED_NODE_MAJOR) must share ONE Node major — with every Node-running job on a pinned setup-node, never the runner\'s implicit Node.');
    process.exit(1);
  }
  console.log('✓ toolchain-consistency gate passed (every Node pin satisfies engines.node; pnpm is single-sourced and declared in the root manifest only; nx agrees with nx.json installation.version; every lockstep package is pinned exactly and @nx/* equals nx; the Playwright image tag matches the lockfile; the images, every setup-node and the Playwright image share ONE Node major; every Node-running job pins its Node with setup-node)');
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
  const as = collectPins('      - uses: pnpm/action-setup@abc\n        with: { version: 10.33.0 }', 'x.yml');
  t('action-setup version parsed', as.length === 1 && as[0].kind === 'pnpm' && as[0].value === '10.33.0');
  // Item #307: the SAME key under a different action is not a pnpm pin. Without this the gate
  // reported uv's five pinned sites as five disagreeing pnpm versions.
  const uv = collectPins("      - uses: astral-sh/setup-uv@abc\n        with:\n          version: '0.12.7'", 'x.yml');
  t("another action's version: input is not read as a pnpm pin", uv.length === 0);
  t('a version: with no enclosing action is not a pnpm pin', collectPins('        with: { version: 10.33.0 }', 'x.yml').length === 0);
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

  // The lockstep pins (2026-10-09, PR #695). Again the case that matters is the REJECTION.
  const decl = (name, spec, file = 'package.json') => ({ file, line: 1, name, spec });
  t('exact, agreeing lockstep pins are clean', compareLockstepDeclarations([decl('nx', '22.7.10'), decl('@nx/expo', '22.7.10'), decl('@playwright/test', '1.63.0')], '22.7.10').length === 0);
  t('THE BUG: a caret @playwright/test is REJECTED', compareLockstepDeclarations([decl('@playwright/test', '^1.59.1')], null).length === 1);
  t('a caret @nx/* plugin is REJECTED', compareLockstepDeclarations([decl('@nx/playwright', '^22.6.3')], '22.7.10').length === 1);
  t('an exact @nx/* plugin that disagrees with nx is REJECTED', compareLockstepDeclarations([decl('@nx/expo', '22.6.3')], '22.7.10').length === 1);
  t('two different exact @playwright/test pins are REJECTED', compareLockstepDeclarations([decl('@playwright/test', '1.63.0'), decl('@playwright/test', '1.64.0', 'a/package.json')], null).length === 1);
  t('a non-lockstep package is ignored', compareLockstepDeclarations([], '22.7.10').length === 0 && !isLockstepPackage('@nxlv/python') && !isLockstepPackage('@monodon/rust'));

  // The Node-major split (item #992). Again the REJECTION is the case worth running.
  const nodePin = (file, value) => ({ file, line: 1, kind: 'node', value, how: 'x' });
  const noPlaywright = { expected: [], missing: [] };
  t('one Node major everywhere is clean', compareNodeMajors([nodePin('frontend/mcm-app/Dockerfile', '26.13.1'), nodePin('a.yml', '26')], { expected: [{ file: 'app-ci.yml', line: 1, value: '26' }], missing: [] }).length === 0);
  t('THE BUG: setup-node on 26 while the shipped image is on 24 is REJECTED', compareNodeMajors([nodePin('frontend/mcm-app/Dockerfile', '24.22.2'), nodePin('a.yml', '26.13.1')], noPlaywright).length === 1);
  t('a Playwright image expected on another major is REJECTED', compareNodeMajors([nodePin('frontend/mcm-app/Dockerfile', '26.13.1')], { expected: [{ file: 'app-ci.yml', line: 1, value: '24' }], missing: [] }).length === 1);
  t('a Playwright run with no expectation is REJECTED', compareNodeMajors([nodePin('frontend/mcm-app/Dockerfile', '26.13.1')], { expected: [], missing: [{ file: 'app-ci.yml', line: 1 }] }).length === 1);
  // The implicit-Node blind spot (2026-11-22). The REJECTIONS are the cases worth running.
  const SN = '      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1\n        with: { node-version: 26.13.1, cache: pnpm }\n';
  const job = (runsOn, steps) => `jobs:\n  j:\n    runs-on: ${runsOn}\n    steps:\n      - uses: actions/checkout@abc\n${steps}`;
  const implicit = (runsOn, steps) => collectImplicitNodeJobs(job(runsOn, steps), 'x.yml');
  t('THE BUG: an ubuntu-latest job running node with no setup-node is REJECTED', implicit('ubuntu-latest', '      - run: node scripts/gate.mjs\n').length === 1);
  t('the finding names the image Node it would run on', /node:22-bookworm/.test(implicit('ubuntu-latest', '      - run: node scripts/gate.mjs\n')[0]?.problem ?? ''));
  t('a kvm host job running pnpm with no setup-node is REJECTED', implicit('kvm', '      - run: bash scripts/ci-log-step.sh x pnpm install --frozen-lockfile\n').length === 1);
  t('node used BEFORE setup-node is REJECTED', implicit('ubuntu-latest', `      - run: node scripts/gate.mjs\n${SN}`).length === 1);
  t('setup-node with no node-version is REJECTED', implicit('ubuntu-latest', '      - uses: actions/setup-node@abc\n      - run: node x.mjs\n').length === 1);
  t('install-pnpm.sh before setup-node (cache: pnpm) is allowed', implicit('ubuntu-latest', `      - run: sh scripts/install-pnpm.sh\n${SN}      - run: pnpm install\n`).length === 0);
  t('install-pnpm.sh with no setup-node at all is REJECTED', implicit('ubuntu-latest', '      - run: sh scripts/install-pnpm.sh\n').length === 1);
  t('setup-node first is clean', implicit('ubuntu-latest', `${SN}      - run: node scripts/gate.mjs\n`).length === 0);
  t('a job that never runs Node needs no setup-node', implicit('ubuntu-latest', '      - run: echo hi\n      - run: docker run node:26 true\n').length === 0);
  t('`npm` in an echo sentence is prose, not Node use', implicit('ubuntu-latest', '      - run: |\n          echo "and npm, which the step below runs"\n').length === 0);
  t('node inside $( ) and after && is Node use', implicit('ubuntu-latest', '      - run: X=$(node -p 1) && true\n').length === 1 && implicit('ubuntu-latest', '      - run: true && pnpm -v\n').length === 1);
  t('a COMMENTED node line is not Node use', implicit('ubuntu-latest', '      - run: |\n          # node scripts/x.mjs\n          echo hi\n').length === 0);
  t('the expectation is read per step', collectPlaywrightNodeExpectations('      - run: |\n          docker run -e EXPECTED_NODE_MAJOR=26 \\\n            mcr.microsoft.com/playwright:v1.65.0-noble \\\n      - run: |\n          docker run \\\n            mcr.microsoft.com/playwright:v1.65.0-noble \\\n', 'x.yml').missing.length === 1);

  if (fails.length) {
    console.error('✗ toolchain-consistency --selftest FAILED:\n  - ' + fails.join('\n  - '));
    process.exit(1);
  }
  console.log('✓ toolchain-consistency --selftest passed (floor comparison, pin extraction, comment immunity, Playwright drift rejection, lockstep exact-pin rejection, Node-major split rejection, implicit-Node job rejection)');
}

// Same guard idiom as check-override-consistency.mjs / check-sast-findings.mjs, and here it is not
// merely tidiness. This block used to run at IMPORT, so `check-toolchain-consistency.test.mjs` — which
// imports findDrift — executed the scan on every run, and the day the repo actually drifted the scan
// called process.exit(1) DURING IMPORT: the whole suite collapsed to one opaque `✖ …test.mjs` at 1:1,
// and (m5), the test asserting the real repo is clean, could never have failed honestly. A gate whose
// own tests die exactly when the gate fires proves nothing. CLI behaviour is byte-for-byte unchanged.
function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--selftest');
  if (unknown.length) {
    console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: check-toolchain-consistency.mjs [--selftest]`);
    process.exit(2);
  }
  if (args.includes('--selftest')) selftest();
  else runScan();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
