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
function repo({ pkg, workflows = {}, dockerfiles = {}, nxJson = null }) {
  const root = mkdtempSync(join(tmpdir(), 'toolchain-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  if (nxJson) writeFileSync(join(root, 'nx.json'), JSON.stringify(nxJson, null, 2));
  mkdirSync(join(root, '.forgejo', 'workflows'), { recursive: true });
  for (const [n, body] of Object.entries(workflows)) writeFileSync(join(root, '.forgejo', 'workflows', n), body);
  for (const [rel, body] of Object.entries(dockerfiles)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
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
