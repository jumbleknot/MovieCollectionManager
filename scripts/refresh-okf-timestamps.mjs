#!/usr/bin/env node
// Clear V12 drift on concepts a regeneration run left unchanged — feature 043 (FR-028 option 1).
//
// Usage:
//   node scripts/refresh-okf-timestamps.mjs                # DRY RUN — report only, writes nothing
//   node scripts/refresh-okf-timestamps.mjs --write         # bump timestamps on drifting concepts
//   node scripts/refresh-okf-timestamps.mjs --selftest
//   node scripts/refresh-okf-timestamps.mjs --bundle <path> # alternate bundle root (test affordance)
//
// Exit codes: 0 clean / selftest passed · 1 selftest broken · 2 bad args.
//
// WHY THIS EXISTS
// The generator only rewrites files it changes. When a regeneration run reads a drifting concept and
// concludes it is still accurate, it leaves the file alone — so the concept's `timestamp` stays old
// and V12 keeps reporting drift forever. With FR-028 triggering regeneration on drift, that means the
// trigger fires on every feature and the conditional step degenerates back into an unconditional one.
// Bumping the timestamp records "verified correct as of now" and lets the signal clear.
//
// ⚠️ READ BEFORE USING — this asserts a claim you must actually have grounds for.
// Bumping a timestamp asserts the concept was VERIFIED against its source. This script cannot verify
// anything itself; it trusts that a regeneration run just examined these pages and chose not to change
// them. Run it ONLY immediately after a completed `wiki-update`, never to silence a noisy signal. Used
// carelessly it launders genuinely stale content as fresh — the exact failure the drift check exists
// to catch. It is deliberately dry-run by default, and the resulting commit is the audit trail.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(REPO_ROOT, 'scripts', 'check-openwiki-okf.mjs');
const DEFAULT_BUNDLE = 'openwiki';

function parseArgs(argv) {
  const opts = { selftest: false, write: false, bundle: DEFAULT_BUNDLE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') opts.selftest = true;
    else if (a === '--write') opts.write = true;
    else if (a === '--bundle') {
      const v = argv[++i];
      if (!v) return { error: '--bundle requires a path' };
      opts.bundle = v;
    } else if (a.startsWith('--bundle=')) opts.bundle = a.slice('--bundle='.length);
    else return { error: `unknown argument: ${a}` };
  }
  return { opts };
}

/** Ask the gate which concepts are drifting. Single source of truth — no duplicated drift logic. */
function driftingConcepts(bundle) {
  const r = spawnSync(process.execPath, [GATE, '--bundle', bundle, '--json'], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  if (!r.stdout?.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  return (parsed.warnings ?? []).filter((w) => w.rule === 'V12').map((w) => w.file);
}

/**
 * Replace an EXISTING `timestamp` in the front matter. Never adds one: a concept without a timestamp
 * has opted out of drift tracking, and giving it one would silently opt it in.
 */
function bumpTimestamp(text, iso) {
  if (!/^---\r?\n/.test(text)) return null;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return null;
  const head = text.slice(0, end);
  if (!/^timestamp:\s*\S/m.test(head)) return null;
  return head.replace(/^timestamp:\s*.*$/m, `timestamp: ${iso}`) + text.slice(end);
}

function refresh(bundle, write, now) {
  const drifting = driftingConcepts(bundle);
  const bumped = [];
  const skipped = [];
  for (const rel of drifting) {
    const abs = resolve(REPO_ROOT, rel);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      skipped.push({ rel, reason: 'unreadable' });
      continue;
    }
    const next = bumpTimestamp(text, now);
    if (next === null) {
      skipped.push({ rel, reason: 'no existing timestamp — not opted into drift tracking' });
      continue;
    }
    if (write) writeFileSync(abs, next);
    bumped.push(rel);
  }
  return { drifting, bumped, skipped };
}

function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'okf-ts-selftest-'));
  const fails = [];
  try {
    // A timestamp is replaced in place, other fields survive.
    const withTs = '---\ntype: R\nresource: README.md\ntimestamp: 2001-01-01T00:00:00Z\n---\nbody\n';
    const out = bumpTimestamp(withTs, '2030-01-01T00:00:00Z');
    if (out === null) fails.push('bump: returned null for a page that has a timestamp');
    else {
      if (out.includes('2001-01-01')) fails.push('bump: old timestamp survived');
      if (!/^type: R$/m.test(out)) fails.push('bump: `type` was lost');
      if (!/^resource: README\.md$/m.test(out)) fails.push('bump: `resource` was lost');
      if (!out.endsWith('body\n')) fails.push('bump: body was altered');
    }

    // A page WITHOUT a timestamp must never be given one.
    if (bumpTimestamp('---\ntype: R\n---\nbody\n', '2030-01-01T00:00:00Z') !== null) {
      fails.push('bump: added a timestamp to a page that had none — that silently opts it into drift tracking');
    }

    // No front matter at all -> untouched.
    if (bumpTimestamp('# plain\n', '2030-01-01T00:00:00Z') !== null) {
      fails.push('bump: modified a page with no front matter');
    }

    // Dry run must not write.
    const dir = join(root, 'b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.md'), '---\ntype: Reference\n---\n# I\n- [a](a.md)\n');
    writeFileSync(join(dir, 'a.md'), withTs);
    refresh(dir, false, '2030-01-01T00:00:00Z');
    if (!readFileSync(join(dir, 'a.md'), 'utf8').includes('2001-01-01')) {
      fails.push('dry run: wrote to disk without --write');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (fails.length > 0) {
    console.error('✗ refresh-okf-timestamps --selftest FAILED:\n  ' + fails.join('\n  '));
    return 1;
  }
  console.log('✓ refresh-okf-timestamps --selftest passed (in-place bump, other fields preserved, never adds a missing timestamp, dry-run writes nothing)');
  return 0;
}

const { opts, error } = parseArgs(process.argv.slice(2));
if (error) {
  console.error(`[okf-timestamps] ${error}`);
  console.error('Usage: node scripts/refresh-okf-timestamps.mjs [--write] [--bundle <path>] [--selftest]');
  process.exit(2);
}
if (opts.selftest) process.exit(selftest());

const now = new Date().toISOString();
const { drifting, bumped, skipped } = refresh(resolve(REPO_ROOT, opts.bundle), opts.write, now);

if (drifting.length === 0) {
  console.log('[okf-timestamps] no drifting concepts — nothing to refresh.');
  process.exit(0);
}

for (const rel of bumped) console.log(`  ${opts.write ? 'bumped' : 'would bump'}  ${rel}`);
for (const s of skipped) console.log(`  skipped ${s.rel} — ${s.reason}`);

if (opts.write) {
  console.log(`[okf-timestamps] refreshed ${bumped.length} concept(s) to ${now}.`);
  console.log('[okf-timestamps] ⚠️  This asserts these concepts were VERIFIED against their sources by the');
  console.log('[okf-timestamps]     regeneration run you just completed. If that is not true, revert — a bump');
  console.log('[okf-timestamps]     on unverified content launders stale documentation as fresh.');
} else {
  console.log(`[okf-timestamps] dry run — ${bumped.length} concept(s) would be refreshed. Re-run with --write.`);
  console.log('[okf-timestamps] Only do so immediately after a completed `pnpm nx wiki-update`.');
}
process.exit(0);
