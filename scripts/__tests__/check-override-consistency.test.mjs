// Guards scripts/check-override-consistency.mjs.
//
// Every entry in pnpm-workspace.yaml's `overrides:` map is a security control stored as a RANGE
// KEYED ON A RANGE: the key names the vulnerable span being excluded, the value names the patched
// floor being forced. Move one half without the other and the result still LOOKS remediated — the
// override no longer excludes the version its own key names.
//
// That is not hypothetical. PR #141 half-bumped the nx pair (package.json raised, nx.json left
// behind); the stale half won at runtime and the security update the PR existed for would not have
// taken effect. And it is now a standing risk here rather than a latent one: Renovate's built-in npm
// manager reads `fast-uri@<3.1.4` as an opaque DEPNAME and `>=3.1.4 <4` as the version, so every
// floor raise it proposes rewrites the value and leaves the key stale, by construction (measured on
// run 1704, 2026-08-13 — 12 deps extracted from this file, five with pending updates).
//
// The riskiest way to get this guard wrong is the opposite direction: three legitimate PLAIN PINS
// have no key half at all, and flagging them would be a gate that fails on correct input. Case (d)
// pins that.
//
// Every case runs against a throwaway directory through the `--dir` seam. Nothing here reads or
// writes the real pnpm-workspace.yaml.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = resolve(HERE, '..', 'check-override-consistency.mjs');

/** Write a throwaway pnpm-workspace.yaml holding `overrides` and run the gate against it. */
function runAgainst(overridesYaml) {
  const root = mkdtempSync(join(tmpdir(), 'overrides-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), `packages:\n  - 'frontend/*'\n\noverrides:\n${overridesYaml}\n`);
  const res = spawnSync(process.execPath, [GATE, '--dir', root], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

test('(a) value raised, vulnerable-range key left stale — the half-bump', () => {
  const { status, out } = runAgainst("  fast-uri@<3.1.4: '>=3.1.5 <4'");
  assert.equal(status, 1, `expected a mismatch to fail the gate\n${out}`);
  assert.match(out, /fast-uri/, 'the failure must name the offending entry');
  assert.match(out, /3\.1\.4/, 'the failure must show the stale key bound');
  assert.match(out, /3\.1\.5/, 'the failure must show the raised value bound');
});

test('(b) key raised, patched-floor value left stale — the mismatch is symmetric', () => {
  const { status, out } = runAgainst("  fast-uri@<3.1.5: '>=3.1.4 <4'");
  assert.equal(status, 1, `a mismatch in the other direction must fail too\n${out}`);
  assert.match(out, /fast-uri/);
});

test('(c) both halves agreeing passes', () => {
  const { status, out } = runAgainst("  fast-uri@<3.1.4: '>=3.1.4 <4'");
  assert.equal(status, 0, `an agreeing pair must pass\n${out}`);
});

test('(c2) a compound vulnerable range compares only its exclusive upper bound', () => {
  const { status, out } = runAgainst("  js-yaml@>=3.0.0 <3.15.1: '>=3.15.1 <4'");
  assert.equal(status, 0, `only the '<' bound of a compound key is in scope\n${out}`);
});

test('(d) the three legitimate plain pins are out of scope, not violations', () => {
  // A guard that fails on correct input is worse than no guard. These have no key half at all.
  const { status, out } = runAgainst(
    ["  react-dom: 19.2.3", "  postcss: '>=8.5.18'", "  '@expo/dom-webview': ^56.0.5"].join('\n'),
  );
  assert.equal(status, 0, `plain pins carry no vulnerable-range key and must pass\n${out}`);
});

test('(e) a scoped package name is split on the LAST @, not the first', () => {
  const agreeing = runAgainst("  '@scope/name@<1.2.3': '>=1.2.3 <2'");
  assert.equal(agreeing.status, 0, `a scoped keyed floor must parse and agree\n${agreeing.out}`);

  const mismatched = runAgainst("  '@scope/name@<1.2.3': '>=1.2.4 <2'");
  assert.equal(mismatched.status, 1, `a scoped keyed floor must still be checked\n${mismatched.out}`);
  assert.match(mismatched.out, /@scope\/name/, 'the scoped name must survive the split intact');
});

test('(f) a keyed floor whose value has no >= bound exits 2 rather than being silently skipped', () => {
  // Silently skipping the entry it cannot read is exactly how a gate comes to protect nothing.
  const { status, out } = runAgainst("  fast-uri@<3.1.4: '^3.1.4'");
  assert.equal(status, 2, `an unparseable value must be refused out loud\n${out}`);
  assert.match(out, /fast-uri/);
});

test('(g) --selftest proves detection independently of the real map', () => {
  const res = spawnSync(process.execPath, [GATE, '--selftest'], { encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
});

test('(h) an unknown argument is a usage error, not a silent full scan', () => {
  const res = spawnSync(process.execPath, [GATE, '--nope'], { encoding: 'utf8' });
  assert.equal(res.status, 2, `${res.stdout}${res.stderr}`);
});

test('(i) the REAL override map is consistent today — the guard is green on arrival', () => {
  const res = spawnSync(process.execPath, [GATE], { encoding: 'utf8' });
  assert.equal(res.status, 0, `the live pnpm-workspace.yaml must pass\n${res.stdout}${res.stderr}`);
});

// ── Feature 081 US5a (T033) — the CAP rule ─────────────────────────────────────────────────────────
//
// The rule above checks the FLOOR half. Renovate attacks the other half: its npm manager reads a keyed
// override's value as a plain version range and "widens" its upper bound to admit the newest major, so
// `undici@<6.27.0: '>=6.27.0 <7'` arrives as `'>=6.27.0 <9'`. The floor is untouched, so the floor rule
// above stays green — and the override now hands any dependent that resolved into the vulnerable span
// a DIFFERENT MAJOR than it declared (research R2; fc3c47ae measured js-yaml 5 sneaking in this way).
// Measured 2026-10-18 on the Dependency Dashboard (item #29): six such proposals were pending, all six
// in the table below.
//
// THE RULE: a keyed floor's value cap (its exclusive `<` bound) may not exceed the key's major + 1.
// A cap tighter than the major is fine; a value with NO cap is reported by name and out of this rule's
// scope (four exist on `main` and pre-date it; capping them would churn the lockfile); a cap written in
// a form the gate cannot read (`<=`, `||`) is refused with exit 2, never skipped.

const LIVE_WIDENINGS = [
  // [key, the value on main, the value Renovate proposed on 2026-10-18]
  ['undici@<6.27.0', '>=6.27.0 <7', '>=6.27.0 <9'],
  ['undici@>=7.0.0 <7.29.1', '>=7.29.1 <8', '>=7.29.1 <9'],
  ['js-yaml@>=3.0.0 <3.15.1', '>=3.15.1 <4', '>=3.15.1 <6'],
  ['js-yaml@>=4.0.0 <4.3.1', '>=4.3.1 <5', '>=4.3.1 <6'],
  ['fast-uri@<3.1.5', '>=3.1.5 <4', '>=3.1.5 <5'],
  ['nanoid@>=3.0.0 <3.3.18', '>=3.3.18 <4', '>=3.3.18 <7'],
];

for (const [key, current, widened] of LIVE_WIDENINGS) {
  test(`(cap) the Renovate widening ${key}: '${widened}' FAILS the gate`, () => {
    const { status, out } = runAgainst(`  '${key}': '${widened}'`);
    assert.equal(status, 1, `a cap past the key's major must fail the gate\n${out}`);
    assert.match(out, /cap/i, 'the failure must say it is the CAP rule that fired');
    assert.ok(out.includes(key), `the failure must name the offending entry ${key}\n${out}`);
  });

  test(`(cap) the value on main, ${key}: '${current}', passes`, () => {
    const { status, out } = runAgainst(`  '${key}': '${current}'`);
    assert.equal(status, 0, `the major-bounded value must pass\n${out}`);
  });
}

test('(cap) a genuine FLOOR RAISE inside the major is still accepted — the security stream stays open', () => {
  const { status, out } = runAgainst("  undici@<6.28.0: '>=6.28.0 <7'");
  assert.equal(status, 0, `a floor raise with both halves moved and the cap kept must pass\n${out}`);
});

test('(cap) a cap tighter than the major passes', () => {
  const { status, out } = runAgainst("  undici@<6.27.0: '>=6.27.0 <6.30.0'");
  assert.equal(status, 0, `a cap below the next major admits no other major\n${out}`);
});

test('(cap) a plain pin is out of the cap rule\'s scope too', () => {
  const { status, out } = runAgainst(["  react-dom: 19.2.3", "  postcss: '>=8.5.18'"].join('\n'));
  assert.equal(status, 0, `plain pins have no key major to cap against\n${out}`);
});

test('(cap) an UNCAPPED keyed floor is out of scope but NAMED, not silently passed', () => {
  const { status, out } = runAgainst("  form-data@<4.0.6: '>=4.0.6'");
  assert.equal(status, 0, `an uncapped floor pre-dates the cap rule and must not fail it\n${out}`);
  assert.match(out, /uncapped/i, 'the pass line must report the uncapped floor');
  assert.ok(out.includes('form-data@<4.0.6'), `the pass line must NAME the uncapped floor\n${out}`);
});

for (const value of ['>=6.27.0 <=8.0.0', '>=6.27.0 <7 || >=8.0.0']) {
  test(`(cap) a value cap the gate cannot read ('${value}') exits 2, never skipped`, () => {
    const { status, out } = runAgainst(`  undici@<6.27.0: '${value}'`);
    assert.equal(status, 2, `an unreadable cap must be refused out loud\n${out}`);
    assert.match(out, /undici/);
  });
}
