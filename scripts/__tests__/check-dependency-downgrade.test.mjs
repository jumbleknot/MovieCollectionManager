// Item #776 — the dependency-downgrade gate. The undici fixture is the measured case from #774:
// nx@23.3.0 pins undici 7.29.0 exactly, so dropping the floor re-resolves 7.29.1 -> 7.29.0.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  compileRange, compareVersions, resolvedVersions, findRegressions, applyAllowlist, DowngradeCheckError,
} from '../check-dependency-downgrade.mjs';

// Every throwaway root is removed when the file finishes (item #901: these leaked, 5,366 at once).
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempRoot = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
import { loadAllowlist } from '../check-sast-findings.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../check-dependency-downgrade.mjs');

/** A pnpm 11+ lockfile: the packageManager document, then the workspace, each with a packages: map. */
function lock(pkgs) {
  const keys = Object.entries(pkgs).flatMap(([name, versions]) =>
    versions.map((v) => (name.startsWith('@') ? `  '${name}@${v}':` : `  ${name}@${v}:`)).map((k) => `${k}\n    resolution: {integrity: sha512-x}\n`));
  return [
    "lockfileVersion: '9.0'", 'importers:', '  .: {}', 'packages:', "  '@pnpm/exe@12.13.0':", '    resolution: {integrity: sha512-x}',
    '---', "lockfileVersion: '9.0'", 'importers:', '  .: {}', 'packages:', '', ...keys,
    'snapshots:', '  undici@6.0.0(peer@1.0.0):', '    dependencies: {}', '',
  ].join('\n');
}

function advisory({ name, range, versions, ghsa = 'GHSA-rfgv-xxqx-mfg5', severity = 'high', patched = '>=7.29.1' }) {
  return {
    module_name: name, vulnerable_versions: range, patched_versions: patched, github_advisory_id: ghsa,
    severity, title: 't', findings: versions.map((version) => ({ version, paths: ['.>x'] })),
  };
}

function run({ base, head, advisories, lockfile = 'pnpm-lock.yaml' }) {
  return findRegressions({
    natives: { [lockfile]: { advisories: Object.fromEntries(advisories.map((a, i) => [String(i + 1), a])) } },
    baseLock: () => (base === null ? null : lock(base)),
    headLock: () => lock(head),
  });
}

// ── ranges ──────────────────────────────────────────────────────────────────────────────────────────

test('compileRange: the comparator forms npm advisories use', () => {
  const cases = [
    ['<7.29.1', { '7.29.0': true, '7.29.1': false, '8.0.0': false, '0.1.0': true }],
    ['>=7.0.0 <7.29.1', { '6.9.9': false, '7.0.0': true, '7.29.0': true, '7.29.1': false }],
    ['<=3.0.3', { '3.0.3': true, '3.0.4': false }],
    ['>=1.0.0 <1.2.3 || >=2.0.0 <2.1.0', { '1.2.2': true, '1.2.3': false, '2.0.5': true, '2.1.0': false, '0.9.0': false }],
    ['<0.0.0', { '0.0.0': false, '1.0.0': false }],
    ['1.2.3 - 1.4.0', { '1.2.2': false, '1.2.3': true, '1.4.0': true, '1.4.1': false }],
    ['<2', { '1.99.0': true, '2.0.0': false }],
    ['<=1.2', { '1.2.9': true, '1.3.0': false }],
    ['>1.2', { '1.2.9': false, '1.3.0': true }],
    ['=1.2.3', { '1.2.3': true, '1.2.4': false }],
    ['1.2.x', { '1.2.0': true, '1.2.7': true, '1.3.0': false }],
    ['*', { '0.0.1': true }],
  ];
  for (const [range, expect] of cases) {
    const inRange = compileRange(range);
    for (const [v, want] of Object.entries(expect)) assert.equal(inRange(v), want, `${v} in "${range}"`);
  }
});

test('compileRange: a prerelease sorts below its release', () => {
  assert.equal(compileRange('<4.6.6')('4.6.6-beta.1'), true);
  assert.ok(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
});

test('compileRange: an unreadable range throws instead of judging (fail-closed)', () => {
  assert.throws(() => compileRange('~>1.2 junk'), DowngradeCheckError);
  assert.throws(() => compileRange('<1.0.0')('not-a-version'), DowngradeCheckError);
});

// ── lockfiles ───────────────────────────────────────────────────────────────────────────────────────

test('resolvedVersions: reads packages: keys in both documents, scoped and quoted, and never snapshots:', () => {
  const m = resolvedVersions(lock({ undici: ['7.29.1', '6.21.0'], '@azure/msal-node': ['6.0.1'] }));
  assert.deepEqual([...m.get('undici')].sort(), ['6.21.0', '7.29.1']);
  assert.deepEqual([...m.get('@azure/msal-node')], ['6.0.1']);
  assert.deepEqual([...m.get('@pnpm/exe')], ['12.13.0']);
  assert.ok(![...m.get('undici')].includes('6.0.0'), 'a snapshots: key (with peer suffix) must not be read');
});

// ── the rule ────────────────────────────────────────────────────────────────────────────────────────

const UNDICI = advisory({ name: 'undici', range: '<7.29.1', versions: ['7.29.0'] });

test('#774 measured case: undici 7.29.1 -> 7.29.0 moves INTO the advisory and is reported', () => {
  const r = run({ base: { undici: ['7.29.1'] }, head: { undici: ['7.29.0'] }, advisories: [UNDICI] });
  assert.equal(r.length, 1);
  assert.deepEqual(
    { name: r[0].name, baseVersions: r[0].baseVersions, version: r[0].version, id: r[0].id, location: r[0].location },
    { name: 'undici', baseVersions: ['7.29.1'], version: '7.29.0', id: 'GHSA-rfgv-xxqx-mfg5', location: 'undici@7.29.0' },
  );
});

test('a NEW affected version beside a kept clean one is still a regression (a second dependent pins it)', () => {
  const r = run({ base: { undici: ['7.29.1'] }, head: { undici: ['7.29.0', '7.29.1'] }, advisories: [UNDICI] });
  assert.equal(r.length, 1);
});

test('a sideways move into a range blocks — "clean" is judged by the advisory range, not version order', () => {
  const a = advisory({ name: 'lib', range: '>=2.0.0 <2.1.0', versions: ['2.0.1'], patched: '>=2.1.0' });
  assert.equal(run({ base: { lib: ['1.5.0'] }, head: { lib: ['2.0.1'] }, advisories: [a] }).length, 1);
});

test('NOT a regression: the upgrade direction (vulnerable -> clean leaves no finding to report)', () => {
  assert.equal(run({ base: { undici: ['7.29.0'] }, head: { undici: ['7.29.1'] }, advisories: [] }).length, 0);
});

test('NOT a regression: the package was already exposed at the base (the main gate owns it)', () => {
  const a = advisory({ name: 'undici', range: '<7.29.1', versions: ['7.28.0', '7.29.0'] });
  assert.equal(run({ base: { undici: ['7.28.0'] }, head: { undici: ['7.28.0', '7.29.0'] }, advisories: [a] }).length, 0);
});

test('NOT a regression: an unchanged vulnerable version (no change made it applicable)', () => {
  assert.equal(run({ base: { undici: ['7.29.0'] }, head: { undici: ['7.29.0'] }, advisories: [UNDICI] }).length, 0);
});

test('NOT a regression: a package new to the lockfile, or a lockfile new in this change', () => {
  assert.equal(run({ base: { other: ['1.0.0'] }, head: { undici: ['7.29.0'] }, advisories: [UNDICI] }).length, 0);
  assert.equal(run({ base: null, head: { undici: ['7.29.0'] }, advisories: [UNDICI] }).length, 0);
});

test('a nested workspace is reported under the same <workspace>:pkg@version location sast-scan uses', () => {
  const r = run({
    base: { undici: ['7.29.1'] }, head: { undici: ['7.29.0'] }, advisories: [UNDICI],
    lockfile: 'tools/openwiki-generator/pnpm-lock.yaml',
  });
  assert.equal(r[0].location, 'tools/openwiki-generator:undici@7.29.0');
});

// ── allowlist: one acceptance decision, shared with the main gate ───────────────────────────────────

function allowlistFile(expiry) {
  const dir = tempRoot('downgrade-allow-');
  const p = join(dir, 'allowlist.yaml');
  writeFileSync(p, [
    '- scanner: "pnpm-audit"', '  id: "GHSA-rfgv-xxqx-mfg5"', '  locationPattern: "^undici@7\\\\.29\\\\.0$"',
    '  justification: "test"', '  addedBy: "test"', `  expiry: "${expiry}"`, '',
  ].join('\n'));
  return p;
}

test('an unexpired allowlist entry accepts the regression; an expired one does not', () => {
  const r = run({ base: { undici: ['7.29.1'] }, head: { undici: ['7.29.0'] }, advisories: [UNDICI] });
  const live = applyAllowlist(r, loadAllowlist(allowlistFile('2099-01-01')), '2026-11-01');
  assert.equal(live.failures.length, 0);
  assert.equal(live.suppressed.length, 1);
  const dead = applyAllowlist(r, loadAllowlist(allowlistFile('2026-10-01')), '2026-11-01');
  assert.equal(dead.failures.length, 1);
});

// ── CLI contract ────────────────────────────────────────────────────────────────────────────────────

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('CLI: --help prints usage and exits 0; an unknown flag or a missing --base is a usage error (2)', () => {
  assert.equal(cli(['--help']).status, 0);
  assert.equal(cli(['--base', 'HEAD', '--dry-run']).status, 2);
  assert.equal(cli([]).status, 2);
});

test('CLI: a missing or empty native report fails closed (1), never "no regression"', () => {
  const dir = tempRoot('downgrade-native-');
  assert.equal(cli(['--base', 'HEAD', '--native', join(dir, 'absent.json')]).status, 1);
  writeFileSync(join(dir, 'empty.json'), '{}');
  assert.equal(cli(['--base', 'HEAD', '--native', join(dir, 'empty.json')]).status, 1);
});

// ── wiring: a gate that is never invoked is indistinguishable from no gate ──────────────────────────

test('guardrails.yml runs the downgrade gate in the sast job, on PRs, AFTER the scan that writes its input', () => {
  const wf = readFileSync(resolve(dirname(SCRIPT), '../.forgejo/workflows/guardrails.yml'), 'utf8');
  const scan = wf.indexOf('ci-log-step.sh sast-static-scan');
  const at = wf.indexOf('node scripts/check-dependency-downgrade.mjs --base "origin/$BASE_REF"');
  assert.ok(scan > 0, 'the sast scan step is gone — update this guard rather than deleting it');
  assert.ok(at > scan, 'the downgrade gate must run after sast-scan.mjs, which writes pnpm-audit-native.json');
  const step = wf.slice(wf.lastIndexOf('- name:', at), at);
  assert.match(step, /if: \$\{\{ github\.event_name == 'pull_request' \}\}/, 'the gate needs a PR base, so it must be PR-scoped');
  assert.match(step, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
});
