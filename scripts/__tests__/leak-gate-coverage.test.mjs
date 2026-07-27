// T012 — leak-gate coverage of the openwiki/ bundle — feature 043 (FR-018).
//
// ⚠️ CHARACTERIZATION TEST — DELIBERATELY EXEMPT FROM THE VERIFY-RED RULE.
// This is the single labelled exception in feature 043 (see specs/043-openwiki-okf/tasks.md, T012).
// FR-018 requires that the whole-tree leak gates' coverage of the bundle be ASSERTED rather than
// assumed. Both gates already walk every tracked file, so this passed the moment it was written.
// That is the correct outcome, not a trivially-passing test to be "fixed": forcing an artificial RED
// would mean breaking a working security gate in order to watch it fail.
//
// Its value is as a REGRESSION GUARD. If either gate is ever narrowed to a path allowlist that omits
// the bundle, or openwiki/ is ever gitignored, this turns red — and either change would silently
// stop scanning generated documentation for leaked infrastructure topology and credentials.
//
// A FAILURE HERE IS A REAL FINDING: it means the bundle is not actually covered, and the gates must
// be widened before any bundle content is committed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanText, RULES } from '../secret-scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLE_PATH = 'openwiki/concepts/example-concept.md';

test('secret-scan detects a credential-shaped string at a bundle path (no path-based exemption)', () => {
  // Assembled from fragments so the joined literal never appears in THIS file — the same technique
  // secret-scan.mjs uses on itself. A literal here would trip the very gate under test.
  const planted = ['TestPass1', '!', 'ok'].join('');
  const page = `---\ntype: Runbook\n---\n\nThe operator password is ${planted} — this must never ship.\n`;

  const hits = scanText(BUNDLE_PATH, page);
  assert.ok(
    hits.length > 0,
    'secret-scan found nothing in a bundle-path page containing a known credential literal — ' +
      'generated documentation would be able to leak credentials past CI',
  );
});

test('secret-scan does not exempt bundle paths — same content, same verdict as any other path', () => {
  const planted = ['TestPass1', '!', 'ok'].join('');
  const page = `password: ${planted}\n`;
  const inBundle = scanText(BUNDLE_PATH, page);
  const elsewhere = scanText('frontend/mcm-app/src/some-file.ts', page);
  assert.equal(
    inBundle.length,
    elsewhere.length,
    'a bundle path is scanned differently from any other path — coverage is path-dependent',
  );
});

test('openwiki/ is not gitignored, so bundle files reach the set both gates scan', () => {
  // Both gates enumerate with `git ls-files`. A gitignored bundle would be invisible to them AND
  // uncommittable — the failure would be silent in both directions.
  const r = spawnSync('git', ['check-ignore', '-q', 'openwiki/INSTRUCTIONS.md'], { cwd: REPO_ROOT });
  assert.notEqual(r.status, 0, 'openwiki/ is gitignored — the leak gates would never see the bundle');
});

test('both leak gates enumerate the WHOLE tracked tree, not a path allowlist', () => {
  // Guards against a future "optimisation" that narrows either gate to a subset of directories.
  for (const gate of ['secret-scan.mjs', 'check-topology-scrub.mjs']) {
    const src = readFileSync(join(REPO_ROOT, 'scripts', gate), 'utf8');
    assert.match(src, /ls-files/, `${gate} no longer enumerates via git ls-files`);
  }
});

test('the topology gate still detects its pattern (detector intact)', () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-topology-scrub.mjs'), '--selftest'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `topology-scrub --selftest failed:\n${r.stdout}${r.stderr}`);
});

test('secret-scan exposes a non-empty rule set', () => {
  assert.ok(Array.isArray(RULES) && RULES.length > 0, 'secret-scan RULES is empty — nothing would be detected');
});

test('a committed bundle is actually enumerated by git ls-files once tracked', () => {
  // Characterizes the mechanism the coverage claim rests on: tracked files under openwiki/ appear in
  // the exact command both gates run. Skips cleanly before the bundle has been committed.
  const tracked = execFileSync('git', ['ls-files', 'openwiki'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  if (tracked.length === 0) return; // bundle not committed yet — nothing to characterize
  assert.ok(
    tracked.every((p) => p.startsWith('openwiki/')),
    'git ls-files returned unexpected paths for the bundle root',
  );
});
