// Guards scripts/check-toolchain-consistency.mjs.
//
// The gate exists because the pnpm 10 → 11 bump broke CI twice on facts that were sitting statically
// in the files (a Node pin below pnpm's `engines`, and a pnpm version pinned in four places). These
// tests pin the exact shapes that broke, so a refactor of the parser cannot quietly stop seeing them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseVersion, compareVersions, satisfiesFloor, collectPins, findDrift, findNxPinDrift,
} from '../check-toolchain-consistency.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = resolve(HERE, '..', 'check-toolchain-consistency.mjs');

/** Build a throwaway repo root with the given files, and run findDrift against it. */
function repo({ pkg, workflows = {}, dockerfiles = {}, nxJson = null, lockfile = null, manifests = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'toolchain-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  if (nxJson) writeFileSync(join(root, 'nx.json'), JSON.stringify(nxJson, null, 2));
  // Taken as TEXT, not as an object to serialise: the cases that matter are malformed, absent and
  // multi-resolution lockfiles, and a serialised object cannot express any of them.
  if (lockfile !== null) writeFileSync(join(root, 'pnpm-lock.yaml'), lockfile);
  mkdirSync(join(root, '.forgejo', 'workflows'), { recursive: true });
  for (const [n, body] of Object.entries(workflows)) writeFileSync(join(root, '.forgejo', 'workflows', n), body);
  for (const [rel, body] of Object.entries(dockerfiles)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  // Nested package.json manifests, for the (m) family. Serialised rather than taken as text: the
  // cases that matter are all about a KEY being present, which an object expresses exactly.
  for (const [rel, body] of Object.entries(manifests)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(body, null, 2));
  }
  return root;
}

const PKG = { packageManager: 'pnpm@11.17.0', engines: { node: '>=22.13' } };

// --- (a) version comparison ---------------------------------------------------------------------

test('(a) versions parse and pad, junk is rejected', () => {
  assert.deepEqual(parseVersion('22.13'), [22, 13, 0]);
  assert.deepEqual(parseVersion('24.14.1'), [24, 14, 1]);
  assert.equal(parseVersion('lts/*'), null);
  assert.ok(compareVersions([24, 0, 0], [22, 13, 0]) > 0);
});

test('(b) THE BUG: Node 20 does not satisfy pnpm 11\'s >=22.13', () => {
  assert.equal(satisfiesFloor('20', '>=22.13'), false);
  assert.equal(satisfiesFloor('22.12', '>=22.13'), false);
  assert.equal(satisfiesFloor('22.13', '>=22.13'), true);
  assert.equal(satisfiesFloor('24', '>=22.13'), true);
});

test('(c) a floor form the parser does not understand throws rather than guessing', () => {
  // A half-implemented semver that silently mis-reads `^22` would be worse than refusing it.
  assert.throws(() => satisfiesFloor('24', '^22'), /plain ">=/);
});

// --- (d) pin extraction — the exact shapes that broke CI -----------------------------------------

test('(d) every real pin shape in this repo is recognised', () => {
  const cases = [
    ['        with: { node-version: 20, cache: pnpm }', 'node', '20'],
    ['          node-version: 24', 'node', '24'],
    ['FROM node:24.14.1-alpine3.23 AS builder', 'node', '24.14.1'],
    ['FROM node:24-bookworm', 'node', '24'],
    ['RUN corepack enable && corepack prepare pnpm@11.17.0 --activate', 'pnpm', '11.17.0'],
    ['        with: { version: 10.33.0 }', 'pnpm', '10.33.0'],
  ];
  for (const [line, kind, value] of cases) {
    const pins = collectPins(line, 'f');
    assert.equal(pins.length, 1, `no pin found in: ${line}`);
    assert.equal(pins[0].kind, kind, line);
    assert.equal(pins[0].value, value, line);
  }
});

test('(d2) a COMMENT mentioning a pin is not treated as one', () => {
  // cd-deploy.yml carries prose explaining the old `version: 10.33.0` pin. Reading that as a real
  // pin would make the gate permanently, unfixably red.
  assert.deepEqual(collectPins('      # pin `version: 10.33.0` explicitly, which made it DUAL-sourced', 'f'), []);
  assert.deepEqual(collectPins('# FROM node:20 was the old base', 'f'), []);
});

// --- (e) end-to-end drift detection --------------------------------------------------------------

test('(e) a Node pin below the floor is caught, and names the file+line', () => {
  const root = repo({ pkg: PKG, workflows: { 'ci.yml': 'jobs:\n  a:\n    steps:\n      - with: { node-version: 20, cache: pnpm }\n' } });
  const d = findDrift(root);
  assert.equal(d.length, 1);
  assert.match(d[0].problem, /BELOW the repo floor/);
  assert.equal(d[0].file, '.forgejo/workflows/ci.yml');
  assert.ok(d[0].line > 0);
});

test('(f) a pnpm version disagreeing with packageManager is caught', () => {
  const root = repo({ pkg: PKG, dockerfiles: { 'frontend/mcm-app/Dockerfile': 'FROM node:24-alpine\nRUN corepack prepare pnpm@10.33.0 --activate\n' } });
  const d = findDrift(root);
  assert.equal(d.length, 1);
  assert.match(d[0].problem, /disagrees with packageManager/);
});

test('(g) an agreeing repo is clean', () => {
  const root = repo({
    pkg: PKG,
    workflows: { 'ci.yml': 'jobs:\n  a:\n    steps:\n      - with: { node-version: 24.14.1, cache: pnpm }\n' },
    dockerfiles: { 'frontend/mcm-app/Dockerfile': 'FROM node:24.14.1-alpine3.23\nRUN corepack prepare pnpm@11.17.0 --activate\n' },
  });
  assert.deepEqual(findDrift(root), []);
});

test('(h) action-setup with NO version is the preferred form and always passes', () => {
  // Omitting `version:` makes it read packageManager — that is how the pin stays single-sourced.
  const root = repo({ pkg: PKG, workflows: { 'ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: pnpm/action-setup@abc\n' } });
  assert.deepEqual(findDrift(root), []);
});

test('(i) a missing engines.node floor fails loudly rather than passing vacuously', () => {
  const root = repo({ pkg: { packageManager: 'pnpm@11.17.0' } });
  const d = findDrift(root);
  assert.equal(d.length, 1);
  assert.match(d[0].problem, /engines\.node/);
});

test('(j) an unparseable Node pin is reported, never silently accepted', () => {
  const root = repo({ pkg: PKG, workflows: { 'ci.yml': 'jobs:\n  a:\n    steps:\n      - with: { node-version: lts/*, cache: pnpm }\n' } });
  const d = findDrift(root);
  assert.equal(d.length, 1);
  assert.match(d[0].problem, /not a plain version/);
});

// --- (k) the real repo, and the CLI contract -----------------------------------------------------

test('(k) the REAL repo passes — this is the invariant the gate protects', () => {
  const r = spawnSync('node', [GATE], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('(l) --selftest passes; an unknown arg exits 2', () => {
  assert.equal(spawnSync('node', [GATE, '--selftest'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('node', [GATE, '--bogus'], { encoding: 'utf8' }).status, 2);
});

// --- (h) the Nx wrapper pin -----------------------------------------------------------------------
//
// THE BUG, measured 2026-08-01: Renovate's `[security]` bump moved package.json devDependencies.nx
// to 22.7.2 and merged green, while nx.json installation.version stayed at 22.6.3. The wrapper
// resolves the CLI from the GITIGNORED .nx/installation using the nx.json pin, so every `pnpm nx`
// — CI included — kept running 22.6.3 and the security update simply did not take effect.

test('(h) THE BUG: a package.json-only nx bump is caught, and says the wrapper wins', () => {
  const root = repo({
    pkg: { ...PKG, devDependencies: { nx: '22.7.2' } },
    nxJson: { installation: { version: '22.6.3' } },
  });
  const d = findNxPinDrift(root);
  assert.equal(d.length, 1, 'the disagreement must be reported');
  assert.equal(d[0].file, 'nx.json');
  assert.match(d[0].problem, /22\.6\.3/);
  assert.match(d[0].problem, /22\.7\.2/);
  assert.match(d[0].problem, /WRAPPER wins/, 'it must say which pin actually decides');
  assert.match(d[0].problem, /security/i, 'and why a silent disagreement is worse than a break');
});

test('(h2) agreeing pins are clean', () => {
  const root = repo({
    pkg: { ...PKG, devDependencies: { nx: '22.7.2' } },
    nxJson: { installation: { version: '22.7.2' } },
  });
  assert.deepEqual(findNxPinDrift(root), []);
});

test('(h3) a RANGE is refused rather than assumed to cover the pin', () => {
  // "^22.7.2 includes 22.6.3" is false, but a lenient comparison that shrugged at ranges would
  // reinstate exactly the bug above.
  const root = repo({
    pkg: { ...PKG, devDependencies: { nx: '^22.7.2' } },
    nxJson: { installation: { version: '22.6.3' } },
  });
  const d = findNxPinDrift(root);
  assert.equal(d.length, 1);
  assert.match(d[0].problem, /pinned exactly/);
});

test('(h4) no installation block means the wrapper is unused — not drift', () => {
  const root = repo({ pkg: { ...PKG, devDependencies: { nx: '22.7.2' } }, nxJson: { plugins: [] } });
  assert.deepEqual(findNxPinDrift(root), []);
});

test('(h5) an installation pin with NO nx dependency is reported, not skipped', () => {
  const root = repo({ pkg: { ...PKG }, nxJson: { installation: { version: '22.7.2' } } });
  const d = findNxPinDrift(root);
  assert.equal(d.length, 1);
  assert.match(d[0].problem, /declares no nx dependency/);
});

test('(h6) a repo with no nx.json is not an Nx workspace — silent pass is correct here', () => {
  assert.deepEqual(findNxPinDrift(repo({ pkg: { ...PKG, devDependencies: { nx: '22.7.2' } } })), []);
});

test('(h7) THIS repo agrees — the gate is wired into findDrift, not merely exported', () => {
  const real = resolve(HERE, '..', '..');
  const nx = findDrift(real).filter((f) => f.file === 'nx.json' || /nx/i.test(f.problem));
  assert.deepEqual(nx, [], `nx pins disagree in this repo: ${JSON.stringify(nx)}`);
});

// --- (w) a finding's location is emitted platform-independently (feature 051 US5) ----------------
//
// `filesToScan` builds each scanned path with `join()`, so on Windows a finding reads
// `.forgejo\workflows\app-ci.yml` while on Linux it reads `.forgejo/workflows/app-ci.yml`. The test
// that pins the output then fails on Windows for a reason that is not the developer's fault — and a
// suite that goes red for reasons nobody caused is a suite people learn to ignore.
//
// THIS IS A SOURCE FIX, NOT A TEST FIX. The findings output is a report a human reads and pastes
// into an issue; a stable forward-slash representation is worth more than the platform's native
// separator. The test is asserting the more useful contract, so the source moves to meet it.
//
// Tested through the normalizer DIRECTLY with a backslash-bearing input, so the case is RED on Linux
// too. Asserting on `join()` output would pass trivially here and prove nothing about Windows —
// which is the whole failure mode this story is about.

// Imported per-case, not at module scope: a static import of a not-yet-existing export throws at
// LOAD time and takes every other case in this file with it, collapsing the collected count to 1 and
// hiding what the RED actually proves. (That is the same defect T044 fixes on Windows — worth not
// reproducing here deliberately.)
const gate = () => import('../check-toolchain-consistency.mjs');

test('(w) a backslash-separated location is emitted with forward slashes', async () => {
  const { posixLocation } = await gate();
  assert.equal(posixLocation('.forgejo\\workflows\\app-ci.yml'), '.forgejo/workflows/app-ci.yml');
  assert.equal(posixLocation('infrastructure-as-code\\docker\\stacks\\mcm.compose.yaml'),
    'infrastructure-as-code/docker/stacks/mcm.compose.yaml');
});

test('(w2) an already-POSIX location is unchanged, and normalization is idempotent', async () => {
  const { posixLocation } = await gate();
  const p = '.forgejo/workflows/app-ci.yml';
  assert.equal(posixLocation(p), p);
  assert.equal(posixLocation(posixLocation('.forgejo\\workflows\\app-ci.yml')), '.forgejo/workflows/app-ci.yml');
});

test('(w3) every finding this gate reports carries a POSIX location', async () => {
  const { collectPins } = await gate();
  // The end-to-end property, not just the helper: a normalizer nothing calls fixes nothing.
  for (const f of collectPins('  - uses: actions/setup-node\n    node-version: 18.0.0\n', '.forgejo\\workflows\\x.yml')) {
    assert.doesNotMatch(f.file, /\\/, `a finding kept a backslash location: ${f.file}`);
  }
});

// --- (p) the Playwright image pin (feature 061, item #204) ---------------------------------------
//
// THE BUG, measured on PR #199 (2026-08-15). A lock-file-maintenance PR moved @playwright/test
// 1.60.0 → 1.62.1 while `.forgejo/workflows/app-ci.yml` kept
// `mcr.microsoft.com/playwright:v1.60.0-noble`. The image TAG selects the baked browser build, so
// the browser never launched and ZERO tests ran — `[e2e-gate] failed=0 flaky=0 passed=0`, which is
// not the same as producing good counts. It cost a full ~35-minute app-e2e cycle and presented as a
// generic "app-e2e failed"; the diagnosis needed a container-log read.
//
// The manifest is NOT the authority and these tests must keep proving it: package.json declares
// `^1.36.0`, which was unchanged before and after the move. Only the RESOLUTION moved, so a gate
// reading package.json would have passed the exact PR it exists to catch.

/** pnpm-lock.yaml text whose `section` map has exactly the given keys. */
const lockText = (keys, section = 'packages') =>
  `lockfileVersion: '9.0'\n\n${section}:\n` +
  keys.map((k) => `  '${k}':\n    resolution: {integrity: sha512-deadbeef}\n`).join('');

/** An app-ci.yml-shaped workflow whose Playwright docker run pins each given version in turn. */
const workflowPinning = (...versions) =>
  'jobs:\n  app-e2e:\n    steps:\n' +
  versions
    .map(
      (v) =>
        '      - name: E2E\n        run: |\n          docker run --network host \\\n' +
        `            mcr.microsoft.com/playwright:v${v}-noble \\\n` +
        '            sh -c "corepack enable && pnpm exec playwright test"\n',
    )
    .join('');

test('(p) the resolved version comes from the lockfile, not the manifest range', async () => {
  const { collectLockfilePlaywrightVersions } = await gate();
  const root = repo({ pkg: PKG, lockfile: lockText(['@playwright/test@1.62.1']) });
  assert.deepEqual(collectLockfilePlaywrightVersions(root), ['1.62.1']);
});

test('(p2) a lockfile that carries the package only under snapshots still resolves', async () => {
  const { collectLockfilePlaywrightVersions } = await gate();
  const root = repo({ pkg: PKG, lockfile: lockText(['@playwright/test@1.62.1'], 'snapshots') });
  assert.deepEqual(collectLockfilePlaywrightVersions(root), ['1.62.1']);
});

test('(p3) a COMPOUND peer key that merely contains the name is not a resolution', async () => {
  // The case that makes parsing worth 320ms over a text match. This key is real — pnpm-lock.yaml
  // carries `'@nx/playwright@22.7.8(...)(@playwright/test@1.62.1)(...)'`, and a regex looking for
  // the name anywhere finds it INSIDE that key. Correctness would then rest on the lockfile's
  // indentation never changing; reading the map's own keys cannot be defeated that way.
  const { collectLockfilePlaywrightVersions } = await gate();
  const root = repo({
    pkg: PKG,
    lockfile: lockText(['@nx/playwright@22.7.8(@babel/traverse@7.29.8)(@playwright/test@1.62.1)(nx@22.7.8)']),
  });
  assert.deepEqual(collectLockfilePlaywrightVersions(root), []);
});

test('(p4) a lockfile without the package resolves nothing — it does not invent a version', async () => {
  const { collectLockfilePlaywrightVersions } = await gate();
  const root = repo({ pkg: PKG, lockfile: lockText(['typescript@5.9.0']) });
  assert.deepEqual(collectLockfilePlaywrightVersions(root), []);
});

test('(p5) two resolutions are BOTH returned — the caller must never silently pick one', async () => {
  const { collectLockfilePlaywrightVersions } = await gate();
  const root = repo({
    pkg: PKG,
    lockfile: lockText(['@playwright/test@1.62.1', '@playwright/test@1.60.0']),
  });
  assert.deepEqual(collectLockfilePlaywrightVersions(root).sort(), ['1.60.0', '1.62.1']);
});

test('(p6) one image pin is found, with its version and 1-indexed line', async () => {
  const { collectPlaywrightImagePins } = await gate();
  const pins = collectPlaywrightImagePins(workflowPinning('1.62.1'), 'app-ci.yml');
  assert.equal(pins.length, 1);
  assert.equal(pins[0].value, '1.62.1');
  assert.equal(pins[0].file, 'app-ci.yml');
  // Counted from the fixture, not read off the implementation: jobs/app-e2e/steps (1-3), then
  // `- name:` (4), `run: |` (5), `docker run` (6), and the image on 7.
  assert.equal(pins[0].line, 7, 'the reported line must be the one a reader can open');
});

test('(p7) EVERY occurrence is found — a partial bump is only visible if both are read', async () => {
  const { collectPlaywrightImagePins } = await gate();
  const pins = collectPlaywrightImagePins(workflowPinning('1.62.1', '1.60.0'), 'app-ci.yml');
  assert.equal(pins.length, 2, 'reading only the first occurrence passes a half-bump');
  assert.deepEqual(pins.map((p) => p.value), ['1.62.1', '1.60.0']);
  assert.notEqual(pins[0].line, pins[1].line, 'each occurrence needs its own line number');
});

test('(p8) the scan is not capped at the two occurrences that exist today', async () => {
  const { collectPlaywrightImagePins } = await gate();
  const pins = collectPlaywrightImagePins(workflowPinning('1.62.1', '1.62.1', '1.60.0'), 'app-ci.yml');
  assert.equal(pins.length, 3, 'a third docker run added later must be covered without editing the gate');
});

test('(p9) a COMMENT naming an image is not treated as a pin', async () => {
  // app-ci.yml carries heavy comment prose around this block, and this feature adds more. The same
  // immunity collectPins() already has for Node/pnpm pins — prose describing a past pin is prose.
  const { collectPlaywrightImagePins } = await gate();
  const text = '      # was mcr.microsoft.com/playwright:v1.60.0-noble before the 1.62.1 bump\n';
  assert.deepEqual(collectPlaywrightImagePins(text, 'app-ci.yml'), []);
});

test('(p10) a different OS variant is not interchangeable with the pinned one', async () => {
  // The suffix is what selects the image, not decoration. A -jammy line pinning the "right" number
  // is still a different browser build, so it must not be read as the -noble pin.
  const { collectPlaywrightImagePins } = await gate();
  const text = '            mcr.microsoft.com/playwright:v1.62.1-jammy \\\n';
  assert.deepEqual(collectPlaywrightImagePins(text, 'app-ci.yml'), []);
});

test('(p11) no image line at all yields no pins — the emptiness is the caller\'s to judge', async () => {
  const { collectPlaywrightImagePins } = await gate();
  assert.deepEqual(collectPlaywrightImagePins('jobs:\n  a:\n    steps: []\n', 'app-ci.yml'), []);
});

test('(p12) an image pin finding carries a POSIX location', async () => {
  const { collectPlaywrightImagePins } = await gate();
  const pins = collectPlaywrightImagePins(workflowPinning('1.62.1'), '.forgejo\\workflows\\app-ci.yml');
  assert.equal(pins[0].file, '.forgejo/workflows/app-ci.yml');
});

/** A root whose lockfile resolves `resolved` and whose app-ci.yml pins each of `pinned`. */
const playwrightRepo = (resolved, ...pinned) =>
  repo({
    pkg: PKG,
    lockfile: lockText(resolved.map((v) => `@playwright/test@${v}`)),
    workflows: { 'app-ci.yml': workflowPinning(...pinned) },
  });

test('(p13) an agreeing pair is clean', async () => {
  const { findPlaywrightPinDrift } = await gate();
  assert.deepEqual(findPlaywrightPinDrift(playwrightRepo(['1.62.1'], '1.62.1', '1.62.1')), []);
});

test('(p14) THE BUG: a lockfile-only bump is caught, and names BOTH versions', async () => {
  const { findPlaywrightPinDrift } = await gate();
  const d = findPlaywrightPinDrift(playwrightRepo(['1.62.1'], '1.60.0', '1.60.0'));
  assert.equal(d.length, 2, 'every stale occurrence is its own finding');
  assert.equal(d[0].file, '.forgejo/workflows/app-ci.yml');
  assert.match(d[0].problem, /1\.62\.1/, 'the resolved runner version must be named');
  assert.match(d[0].problem, /1\.60\.0/, 'and the stale tag version');
  assert.match(d[0].problem, /browser/i, 'and WHY it matters — the tag selects the browser build');
  assert.match(d[0].problem, /zero tests|no tests/i, 'and what the symptom looks like');
});

test('(p15) THE PARTIAL BUMP: one of two occurrences moved is still a failure', async () => {
  // Criterion 2 of item #204. A gate that reads only the first occurrence passes this.
  const { findPlaywrightPinDrift } = await gate();
  const d = findPlaywrightPinDrift(playwrightRepo(['1.62.1'], '1.62.1', '1.60.0'));
  assert.equal(d.length, 1, 'the one stale occurrence must be reported');
  assert.match(d[0].problem, /1\.60\.0/);
});

test('(p16) the tag disappearing is a FINDING, never a vacuous pass', async () => {
  // A gate that passes because it found nothing to compare has stopped working without saying so.
  const { findPlaywrightPinDrift } = await gate();
  const d = findPlaywrightPinDrift(playwrightRepo(['1.62.1']));
  assert.equal(d.length, 1);
  assert.match(d[0].problem, /no .*playwright.*image|found no/i);
});

test('(p17) two resolved versions are reported rather than one being picked', async () => {
  const { findPlaywrightPinDrift } = await gate();
  const d = findPlaywrightPinDrift(playwrightRepo(['1.62.1', '1.60.0'], '1.62.1', '1.62.1'));
  assert.equal(d.length, 1);
  assert.equal(d[0].file, 'pnpm-lock.yaml');
  assert.match(d[0].problem, /1\.60\.0/);
  assert.match(d[0].problem, /1\.62\.1/);
});

test('(p18) an image pinned for a package the lockfile does not carry is reported', async () => {
  const { findPlaywrightPinDrift } = await gate();
  const d = findPlaywrightPinDrift(playwrightRepo([], '1.62.1'));
  assert.equal(d.length, 1);
  assert.match(d[0].problem, /lockfile/i);
});

test('(p19) a repo using Playwright NOWHERE is not drift — the halves are both absent', async () => {
  const { findPlaywrightPinDrift } = await gate();
  assert.deepEqual(findPlaywrightPinDrift(playwrightRepo([])), []);
  // And a repo with no lockfile at all is simply not a pnpm workspace to cross-check.
  assert.deepEqual(findPlaywrightPinDrift(repo({ pkg: PKG })), []);
});

test('(p20) the REAL repo agrees — lockfile and both image tags name one version', async () => {
  const { findPlaywrightPinDrift } = await gate();
  const real = resolve(HERE, '..', '..');
  const d = findPlaywrightPinDrift(real);
  assert.deepEqual(d, [], `the Playwright pin has drifted: ${JSON.stringify(d, null, 2)}`);
});

test('(p22) the success line NAMES the Playwright relation it just proved', () => {
  // A gate that checks four relations and enumerates three leaves a reader unable to tell whether
  // the fourth ran. "It passed" must say what it passed, or a silently-disabled check reads exactly
  // like a working one.
  const r = spawnSync('node', [GATE], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /playwright/i, `the success line does not mention Playwright: ${r.stdout}`);
});

test('(p21) the relation is wired into findDrift, not merely exported', async () => {
  // The (h7) lesson, for the second pair: a function nothing calls gates nothing. Proven by
  // pointing findDrift at a root that is clean for Node/pnpm/nx and drifted ONLY on Playwright.
  const { findDrift: find } = await gate();
  const root = repo({
    pkg: PKG,
    lockfile: lockText(['@playwright/test@1.62.1']),
    workflows: { 'app-ci.yml': workflowPinning('1.60.0') },
  });
  const d = find(root);
  assert.equal(d.length, 1, `findDrift must surface the Playwright relation, got ${JSON.stringify(d)}`);
  assert.match(d[0].problem, /1\.60\.0/);
});

// --- (m) the SECOND packageManager field (item #286) ---------------------------------------------
//
// Measured 2026-08-29. frontend/mcm-app/package.json carried its own `"packageManager"` alongside the
// root's. Both were written as pnpm@10.33.0 by the npm→pnpm migration (a19962b9); every later bump
// moved the ROOT only, so by the time the root reached pnpm@11.22.0 the app manifest was still on the
// 10.x track — Renovate had been maintaining it there separately (871d79aa moved it 10.33.0 →
// 10.34.5), and the Dependency Dashboard was proposing a `pnpm to v11` MAJOR against it.
//
// The gate did not see it: findDrift reads the ROOT `packageManager` as the single source and then
// checks workflows and Dockerfiles against it. It never looked at another package.json. This is the
// fourth instance of the shape the gate exists for (#194 nx, #204 Playwright, #225 the Dockerfile
// corepack pins) — and the only one where the duplicate pin lives in the same KIND of file as the
// source, which is exactly why nothing noticed.
//
// THE RULE IS "DECLARED ONCE", NOT "DECLARED CONSISTENTLY". A nested manifest whose value AGREES is
// still a finding: corepack and pnpm both resolve `packageManager` from the NEAREST package.json
// above the cwd, so a second field silently wins for anything run inside that directory, and an
// agreeing copy is only ever one bot PR away from drifting — which is precisely how this one drifted.

test('(m) THE BUG: a workspace package declaring its own packageManager is caught', () => {
  const root = repo({
    pkg: PKG,
    manifests: { 'frontend/app/package.json': { name: 'app', packageManager: 'pnpm@10.34.5' } },
  });
  const d = findDrift(root);
  assert.equal(d.length, 1, `expected exactly one finding, got ${JSON.stringify(d)}`);
  assert.equal(d[0].file, 'frontend/app/package.json');
  assert.ok(d[0].line > 0, `finding must carry a real line number, got ${d[0].line}`);
  assert.match(d[0].problem, /packageManager/);
  assert.match(d[0].problem, /10\.34\.5/, 'the finding must name the shadowing version');
  assert.match(d[0].problem, /11\.17\.0/, 'the finding must name the root it disagrees with');
});

test('(m2) an AGREEING nested packageManager is still a finding — the rule is declared ONCE', () => {
  // Not pedantry: this repo's copy agreed on the day it was written and drifted a whole major later.
  const root = repo({
    pkg: PKG,
    manifests: { 'packages/ds/package.json': { name: 'ds', packageManager: 'pnpm@11.17.0' } },
  });
  const d = findDrift(root);
  assert.equal(d.length, 1, `an agreeing duplicate must still be reported, got ${JSON.stringify(d)}`);
  assert.match(d[0].problem, /remove it/i, `the finding must say to REMOVE it: ${d[0].problem}`);
});

test('(m3) a nested manifest WITHOUT the field is clean — the control', () => {
  const root = repo({
    pkg: PKG,
    manifests: { 'packages/ds/package.json': { name: 'ds', private: true } },
  });
  assert.deepEqual(findDrift(root), []);
});

test('(m4) the ROOT manifest is the single source and is never reported against itself', () => {
  // Guards the obvious off-by-one: a walker that does not exclude the root reports the source.
  assert.deepEqual(findDrift(repo({ pkg: PKG })), []);
});

test('(m5) THE REAL REPO declares packageManager exactly ONCE', () => {
  // The invariant this whole family exists to hold, asserted against the tree rather than a fixture.
  const d = findDrift().filter((f) => /packageManager/.test(f.problem));
  assert.deepEqual(d, [], `a second packageManager field is back: ${JSON.stringify(d)}`);
});

test('(m6) importing the gate does NOT run the scan — the module is importable', () => {
  // THE INSTRUMENT CHECK. This module ran `runScan()` at import: every test here imports it, so the
  // scan executed on every run, and once the repo actually drifted it called process.exit(1) DURING
  // IMPORT. The whole file then reported as one opaque `✖ …test.mjs 'test failed'` at 1:1 — including
  // (m5), the assertion that the real repo is clean, which therefore could never have FAILED honestly.
  // A gate whose test suite dies exactly when the gate fires proves nothing. Found while adding (m).
  const r = spawnSync('node', ['--input-type=module', '-e', `await import(${JSON.stringify(GATE)}); console.log('IMPORTED');`], { encoding: 'utf8' });
  assert.equal(r.status, 0, `importing the gate must not exit: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /IMPORTED/);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /toolchain-consistency gate/, 'importing the module ran the CLI scan');
});

test('(m7) the success line NAMES the single-declaration relation it just proved', () => {
  // The (p22) lesson, for the fourth relation: "it passed" must say WHAT it passed, or a check that
  // has been silently disabled reads exactly like a working one.
  const r = spawnSync('node', [GATE], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /root manifest only/i, `the success line does not mention the single declaration: ${r.stdout}`);
});
