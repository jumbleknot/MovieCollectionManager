// Item #165 — web E2E teardown must stay OWNERSHIP-SCOPED, guarded in both directions.
//
// The defect this guards against was invisible for months and read as model nondeterminism.
// `cleanupNonFixtureCollections` deleted EVERY non-fixture collection belonging to the shared
// `E2E_TEST_USER`, on the stated grounds that `fullyParallel: false` serialises tests. It
// serialises tests within a FILE; Playwright still runs different files in parallel across six
// workers, and 21 spec files called it in `afterEach`. So one file's teardown routinely deleted
// another file's live data.
//
// Measured across app-ci runs 1612/1614/1616/1617: the MEDIAN lifetime of a collection was
// **1.3 seconds**, and in run 1617, 36 of 40 were deleted within five seconds of creation — while
// the agent flows that create them need them for a minute or more. Traced end to end on
// `agent-add-ownership.spec.ts:154` in run 1617: collection created 03:53:43.658, movie added
// 03:53:43.681, detail screen loaded 03:53:43.720, **collection_deleted 03:53:45.107** — 1.4 s
// later, with ~88 s of that test's body still to run.
//
// Two ways the remedy rots, each silent:
//
//   1. A helper reappears that deletes by "not a fixture" rather than by ownership. The suite goes
//      green on the machine that wrote it (one worker, no contention) and flakes in CI.
//   2. A spec creates a collection but never claims it. That leaks rather than destroys — the safe
//      direction, deliberately — but it accumulates on the home screen, which is the residue that
//      caused the Phase-3 render timeouts the teardown existed to prevent in the first place.
//
// Deterministic, offline, token-free, node: built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_E2E = join(REPO_ROOT, 'frontend/mcm-app/tests/e2e/web');
const CLEANUP = join(WEB_E2E, 'setup/e2e-cleanup.ts');

const specFiles = () =>
  readdirSync(WEB_E2E)
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => ({ name: f, text: readFileSync(join(WEB_E2E, f), 'utf8') }));

test('the blanket "delete every non-fixture collection" helper is gone, by name', () => {
  const cleanup = readFileSync(CLEANUP, 'utf8');
  assert.ok(
    !/export\s+async\s+function\s+cleanupNonFixtureCollections/.test(cleanup),
    'cleanupNonFixtureCollections is back in e2e-cleanup.ts — it deletes other workers\' in-flight ' +
      'collections. Teardown must delete only what the test claimed via ownCollection().',
  );
  for (const { name, text } of specFiles()) {
    assert.ok(
      !text.includes('cleanupNonFixtureCollections'),
      `${name} calls cleanupNonFixtureCollections — use cleanupOwnedCollections(request).`,
    );
  }
});

test('cleanup filters by ownership, not merely by "is it a fixture"', () => {
  const cleanup = readFileSync(CLEANUP, 'utf8');
  const fn = cleanup.slice(cleanup.indexOf('export async function cleanupOwnedCollections'));
  assert.ok(fn.length > 0, 'cleanupOwnedCollections is missing from e2e-cleanup.ts');
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.ok(
    body.includes('isOwned('),
    'cleanupOwnedCollections no longer consults isOwned() — a filter that keeps only ' +
      '!KEEP.has(name) is the exact blanket delete item #165 removed.',
  );
});

test('ownership matching is exact-or-suffixed, never a loose substring', () => {
  const cleanup = readFileSync(CLEANUP, 'utf8');
  const m = cleanup.match(/function isOwned\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'isOwned() is missing from e2e-cleanup.ts');
  assert.ok(
    !/\.includes\(/.test(m[1]),
    'isOwned() uses substring matching — `"Keep Me"` would then claim another worker\'s ' +
      '`"Keep Me Too"`. Match exactly, or on an `"<owned> "` prefix.',
  );
  assert.ok(
    /startsWith\(`\$\{o\} `\)|startsWith\(o \+ ' '\)/.test(m[1]),
    'isOwned() no longer accepts `"<owned> Suffix"` children — agent-navigate-collection creates ' +
      '`"<prefix> Import"` / `"<prefix> Export"` from one owned base name, and they would leak.',
  );
});

test('every spec that creates a collection also claims it', () => {
  // Creating without claiming leaks (safe, but it is residue). These are the two ways a spec can
  // put a collection on screen: its own POST, and asking the ASSISTANT to create one by name.
  const CREATES = /request\.post\((['"])\/bff-api\/collections\1/;
  const offenders = [];
  for (const { name, text } of specFiles()) {
    if (!CREATES.test(text)) continue;
    if (!/\bownCollection\s*\(/.test(text)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `these specs create a collection but never call ownCollection(), so their teardown deletes ` +
      `nothing and the collection is left on the shared user's home screen: ${offenders.join(', ')}`,
  );
});

test('a spec that tears down at all has something it could own', () => {
  // The inverse slip: calling cleanupOwnedCollections in a spec that never claims anything is a
  // no-op that READS like cleanup. Allowed only for specs that genuinely create nothing (they work
  // against the fixtures), so this asserts the pairing is deliberate by listing them.
  const noOp = [];
  for (const { name, text } of specFiles()) {
    if (!text.includes('cleanupOwnedCollections(')) continue;
    if (!/\bownCollection\s*\(/.test(text)) noOp.push(name);
  }
  assert.deepEqual(
    noOp.sort(),
    ['agent-disambiguation.spec.ts', 'agent-search.spec.ts'],
    'a spec calls cleanupOwnedCollections() but claims nothing — either it creates collections and ' +
      'forgot to claim them, or it creates none and the teardown is decoration. Both are worth ' +
      'seeing; update this list deliberately.',
  );
});
