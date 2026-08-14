#!/usr/bin/env node
// Override-floor consistency gate — both halves of every security override must move together.
//
// WHY THIS EXISTS. Every entry in pnpm-workspace.yaml's `overrides:` map is a security control, and
// each keyed one is stored as a RANGE KEYED ON A RANGE:
//
//     fast-uri@<3.1.4: '>=3.1.4 <4'
//               ^^^^^     ^^^^^
//               the vulnerable span excluded, and the patched floor forced
//
// Raise the value to `>=3.1.5 <4` and leave the key at `<3.1.4` and you get an override that reads
// as remediated but no longer excludes the version its own key names. That failure has already been
// paid for once in this repository in its other instance: PR #141 raised package.json's nx version
// and left nx.json behind, the stale half won at runtime, and the security update the PR existed for
// would not have taken effect. check-toolchain-consistency.mjs is the guard that caught it. This is
// the same guard for the other lockstep pair.
//
// AND IT IS NOT A HYPOTHETICAL HERE. Renovate's built-in npm manager already extracts this file (12
// deps, measured on run 1704, 2026-08-13) — but it reads `fast-uri@<3.1.4` as an opaque DEPNAME and
// `>=3.1.4 <4` as the version. The key half is invisible to it. So every floor RAISE the bot
// proposes is a half-bump by construction, and this gate is what stops one being reviewable as
// correct. It runs on pull requests for exactly that reason.
//
// THE RULE — for every override whose KEY carries an `@<range>` suffix:
//
//     the key's EXCLUSIVE UPPER bound (the version after `<`)
//       must equal
//     the value's INCLUSIVE LOWER bound (the version after `>=`)
//
// SCOPE, and the single most likely way to get this wrong: three legitimate PLAIN PINS
// (`react-dom`, `postcss`, `@expo/dom-webview`) have no key half at all. They are out of the rule's
// scope, not violations — a gate that fails on correct input is worse than no gate. The package-name
// split therefore uses the LAST `@`, so a scoped name (`@scope/name@<1.2.3`) parses and a bare
// scoped pin (`@expo/dom-webview`) does not look like a keyed floor.
//
// A half that cannot be parsed is refused OUT LOUD (exit 2), never skipped. Silently passing over
// the entry it cannot read is how a gate comes to protect nothing.
//
// Usage:
//   node scripts/check-override-consistency.mjs             # scan; exit 0 clean / 1 mismatch
//   node scripts/check-override-consistency.mjs --selftest  # prove detection; exit 0/1
//   node scripts/check-override-consistency.mjs --dir <d>   # scan a different repo root (tests)
//
// Exit codes: 0 clean · 1 mismatch found / selftest broken · 2 bad args, unreadable or unparseable.

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_FILE = 'pnpm-workspace.yaml';

/**
 * Split an override key into its package name and its vulnerable-range suffix.
 *
 * Returns `null` for a PLAIN PIN — a key with no range half, which this gate does not govern.
 * The split is on the LAST `@` so that `@scope/name@<1.2.3` yields `@scope/name`, while a bare
 * `@expo/dom-webview` (whose only `@` is the scope marker at index 0) is correctly a plain pin.
 */
export function parseOverrideKey(key) {
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: key.slice(0, at), vulnerableRange: key.slice(at + 1) };
}

/** The version after `<` in a range — the exclusive upper bound. `null` when absent. */
export function exclusiveUpperBound(range) {
  const m = String(range).match(/<\s*(\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

/** The version after `>=` in a range — the inclusive lower bound. `null` when absent. */
export function inclusiveLowerBound(range) {
  const m = String(range).match(/>=\s*(\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

/** `3.1.4` → [3,1,4]; shorter forms pad with zeros so `4` and `4.0.0` compare equal. */
function parseVersion(v) {
  const [a = 0, b = 0, c = 0] = String(v).split('.').map(Number);
  return [a, b, c];
}

/**
 * Ordered comparison: negative when `x < y`, 0 when equal, positive when `x > y`.
 *
 * EXPORTED FOR REUSE, NOT FOR THIS GATE'S BENEFIT. scripts/override-lever.mjs (feature 058) needs to
 * ask whether an override's permitted range already admits a published fix, which is the same
 * version arithmetic this file already does. Exporting it keeps ONE definition of how a version is
 * parsed and ordered; a second dialect elsewhere is precisely how two halves of a pair drift apart,
 * which is the class of fault this gate exists to catch.
 *
 * This does not widen, narrow or otherwise change what this gate accepts — `sameVersion` below is
 * now expressed in terms of it and behaves identically, which this file's own tests prove.
 */
export function compareVersions(x, y) {
  const a = parseVersion(x);
  const b = parseVersion(y);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function sameVersion(x, y) {
  return compareVersions(x, y) === 0;
}

/**
 * Compare both halves of every keyed floor in an `overrides` map.
 *
 * @returns {{mismatches: Array, unparseable: Array, checked: number, skipped: number}}
 */
export function findOverrideMismatches(overrides) {
  const mismatches = [];
  const unparseable = [];
  let checked = 0;
  let skipped = 0;

  for (const [key, value] of Object.entries(overrides ?? {})) {
    const parsed = parseOverrideKey(key);
    if (!parsed) {
      skipped += 1; // plain pin — no key half, out of scope by design
      continue;
    }

    const keyUpper = exclusiveUpperBound(parsed.vulnerableRange);
    const valueLower = inclusiveLowerBound(value);

    if (keyUpper === null) {
      unparseable.push({ key, value, problem: `the vulnerable-range key '${parsed.vulnerableRange}' carries no '<' upper bound, so its half cannot be compared` });
      continue;
    }
    if (valueLower === null) {
      unparseable.push({ key, value, problem: `the patched-floor value '${value}' carries no '>=' lower bound, so its half cannot be compared` });
      continue;
    }

    checked += 1;
    if (!sameVersion(keyUpper, valueLower)) {
      mismatches.push({ name: parsed.name, key, value, keyUpper, valueLower });
    }
  }

  return { mismatches, unparseable, checked, skipped };
}

/** Read and parse the `overrides` map from a repository root. Throws with a readable message. */
export function readOverrides(root) {
  const path = join(root, WORKSPACE_FILE);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`could not read ${path}: ${e.message}`);
  }
  let doc;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new Error(`could not parse ${path}: ${e.message}`);
  }
  return doc?.overrides ?? {};
}

function reportMismatch(m) {
  return (
    `✗ override key/value mismatch: ${m.name}\n` +
    `    key   ${m.key}    excludes below ${m.keyUpper}\n` +
    `    value ${m.value}    forces at/above ${m.valueLower}\n` +
    `  The key still names ${m.keyUpper} as the vulnerable boundary while the floor forces ${m.valueLower}. ` +
    'Raise both halves together — an override that excludes a range it no longer forces is a half-remediation.'
  );
}

function runScan(root) {
  let overrides;
  try {
    overrides = readOverrides(root);
  } catch (e) {
    console.error(`✗ override-consistency gate could not run: ${e.message}`);
    process.exit(2);
  }

  const { mismatches, unparseable, checked, skipped } = findOverrideMismatches(overrides);

  if (unparseable.length) {
    console.error(`✗ override-consistency gate could not run: ${unparseable.length} keyed floor(s) could not be read:`);
    for (const u of unparseable) console.error(`  ${u.key}: ${JSON.stringify(u.value)} — ${u.problem}`);
    console.error('\nA half this gate cannot parse is refused rather than skipped: silently passing over it would leave the control unguarded.');
    process.exit(2);
  }

  if (mismatches.length) {
    console.error(`✗ override-consistency gate FAILED: ${mismatches.length} of ${checked} keyed floor(s) disagree:`);
    for (const m of mismatches) console.error(reportMismatch(m));
    process.exit(1);
  }

  console.log(`✓ override-consistency gate passed (${checked} keyed floor(s) agree; ${skipped} plain pin(s) carry no key half and are out of scope)`);
}

function selftest() {
  const fails = [];
  const t = (label, cond) => { if (!cond) fails.push(label); };
  const only = (overrides) => findOverrideMismatches(overrides);

  // (a) value raised, key left stale — the half-bump this gate exists for.
  const a = only({ 'fast-uri@<3.1.4': '>=3.1.5 <4' });
  t('(a) a raised value with a stale key is a mismatch', a.mismatches.length === 1 && a.mismatches[0].name === 'fast-uri');

  // (b) key raised, value left stale — the mismatch is symmetric.
  const b = only({ 'fast-uri@<3.1.5': '>=3.1.4 <4' });
  t('(b) a raised key with a stale value is a mismatch', b.mismatches.length === 1);

  // (c) both halves agreeing.
  t('(c) an agreeing pair is clean', only({ 'fast-uri@<3.1.4': '>=3.1.4 <4' }).mismatches.length === 0);

  // (c2) a compound vulnerable range — only the `<` bound is in scope.
  const c2 = only({ 'js-yaml@>=3.0.0 <3.15.1': '>=3.15.1 <4' });
  t('(c2) a compound key compares only its `<` bound', c2.mismatches.length === 0 && c2.checked === 1);

  // (d) the three legitimate plain pins — out of scope, NOT violations.
  const d = only({ 'react-dom': '19.2.3', postcss: '>=8.5.18', '@expo/dom-webview': '^56.0.5' });
  t('(d) plain pins are skipped, not flagged', d.mismatches.length === 0 && d.checked === 0 && d.skipped === 3);

  // (e) a scoped name splits on the LAST `@`.
  t('(e) a scoped keyed floor parses on the last @', parseOverrideKey('@scope/name@<1.2.3')?.name === '@scope/name');
  t('(e) a bare scoped pin is not mistaken for a keyed floor', parseOverrideKey('@expo/dom-webview') === null);
  t('(e) a scoped keyed floor is still checked', only({ '@scope/name@<1.2.3': '>=1.2.4 <2' }).mismatches.length === 1);

  // (f) a value with no `>=` bound is refused out loud, never silently skipped.
  const f = only({ 'fast-uri@<3.1.4': '^3.1.4' });
  t('(f) an unparseable value is reported, not skipped', f.unparseable.length === 1 && f.mismatches.length === 0 && f.checked === 0);

  // Bound extraction, pinned directly.
  t('exclusiveUpperBound reads the < bound', exclusiveUpperBound('>=3.0.0 <3.15.1') === '3.15.1');
  t('inclusiveLowerBound reads the >= bound', inclusiveLowerBound('>=3.15.1 <4') === '3.15.1');
  t('a version with fewer parts still compares equal', only({ 'x@<4': '>=4.0.0' }).mismatches.length === 0);

  if (fails.length) {
    console.error('✗ check-override-consistency --selftest FAILED:\n  - ' + fails.join('\n  - '));
    process.exit(1);
  }
  console.log('✓ check-override-consistency --selftest passed (half-bump detection in both directions, plain-pin scoping, scoped names, unparseable halves)');
}

function main() {
  const args = process.argv.slice(2);
  let root = REPO_ROOT;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dir') {
      root = args[++i];
      if (!root) {
        console.error('--dir requires a directory argument.');
        process.exit(2);
      }
    } else {
      rest.push(args[i]);
    }
  }
  const unknown = rest.filter((a) => a !== '--selftest');
  if (unknown.length) {
    console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: check-override-consistency.mjs [--selftest] [--dir <d>]`);
    process.exit(2);
  }
  if (rest.includes('--selftest')) selftest();
  else runScan(root);
}

// RUN ONLY WHEN INVOKED DIRECTLY. This body used to be top-level, which meant IMPORTING this file
// for its parsers ran the whole scan against the repo and could `process.exit` out of the importing
// process — taking an unrelated test runner or gate down with it, and reporting the exit as that
// caller's result. Nothing had noticed, because the file's own test invokes it as a SUBPROCESS and
// feature 058's override-lever.mjs is its first importer: the failure surfaced immediately there as
// "Unknown argument(s): --report" from a gate that had never heard of `--report`.
//
// Same guard as check-sast-findings.mjs. CLI behaviour is byte-for-byte unchanged — this file's own
// tests shell out exactly as before and must still pass, which is the proof that exporting parsers
// for reuse did not weaken the gate.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
