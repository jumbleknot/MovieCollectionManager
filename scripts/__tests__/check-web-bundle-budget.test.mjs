// Guards scripts/check-web-bundle-budget.mjs (feature 077, T014 — FR-012; US3-AC1/AC2).
//
// The gate exists because item #558's history is a win being spent without anyone noticing: the web
// bundle reached 4.28 MB one ordinary feature at a time, and the only thing that ever complained was
// a performance test whose failure looked like a timeout. This gate complains in bytes, at the point
// of change.
//
// The cases that matter are the ones where a plausible gate reports CLEAN and shouldn't:
//   - no entry chunk at all (an export that never ran);
//   - two entry chunks (the number it reports is not the number it claims);
//   - a deferred package back in the entry chunk while the byte budget still passes;
//   - server code in the DEFERRED chunk, which a gate reading only the entry chunk cannot see;
//   - a missing source map silently disabling the module assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-web-bundle-budget.mjs');
const WEB = 'client/_expo/static/js/web';

/**
 * Build a throwaway `dist` and run the gate over it.
 * `chunks` maps a filename to `{ size, sources }`; a map is emitted when `sources` is given.
 */
function runGate(chunks, args = []) {
  const root = mkdtempSync(join(tmpdir(), 'bundle-budget-'));
  const dir = join(root, WEB);
  mkdirSync(dir, { recursive: true });
  for (const [name, { size = 100, sources }] of Object.entries(chunks)) {
    writeFileSync(join(dir, name), 'x'.repeat(size));
    if (sources) {
      writeFileSync(join(dir, `${name}.map`), JSON.stringify({ version: 3, sources, mappings: '' }));
    }
  }
  const r = spawnSync('node', [GATE, '--dist', root, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const CLEAN_SOURCES = ['/app/src/screens/home/home-screen.tsx', '/node_modules/expo-router/build/index.js'];

test('under budget passes, reporting measured and budget', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 500, sources: CLEAN_SOURCES } },
    ['--budget', '1000'],
  );
  assert.equal(code, 0, out);
  assert.match(out, /500/, 'must report the measured size');
  assert.match(out, /1,?000/, 'must report the budget');
});

test('over budget fails, naming measured, budget AND overage', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 1500, sources: CLEAN_SOURCES } },
    ['--budget', '1000'],
  );
  assert.equal(code, 1, out);
  assert.match(out, /1,?500/, 'measured');
  assert.match(out, /1,?000/, 'budget');
  assert.match(out, /500/, 'overage');
});

test('ZERO entry chunks fails — an export that never ran must not read as clean', () => {
  const { code, out } = runGate({ 'assistant-panel-x.js': { size: 10 } });
  assert.equal(code, 1, out);
  assert.match(out, /entry/i, out);
});

test('TWO entry chunks fails — the reported number would not be the claimed number', () => {
  const { code, out } = runGate({
    'entry-aaa.js': { size: 100, sources: CLEAN_SOURCES },
    'entry-bbb.js': { size: 100, sources: CLEAN_SOURCES },
  });
  assert.equal(code, 1, out);
  assert.match(out, /entry/i, out);
});

test('a deferred package back in the entry chunk fails, naming it, even UNDER budget', () => {
  // The byte budget measures the symptom; the module list measures the cause. A change that
  // re-imports the assistant at the root while something else shrinks would pass on bytes alone.
  const { code, out } = runGate(
    {
      'entry-abc.js': {
        size: 100,
        sources: [...CLEAN_SOURCES, '/node_modules/.pnpm/zod@3.25.76/node_modules/zod/lib/index.js'],
      },
    },
    ['--budget', '100000'],
  );
  assert.equal(code, 1, out);
  assert.match(out, /zod/, 'must name the package that came back');
});

test('text-encoding back in the entry chunk fails', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 100, sources: [...CLEAN_SOURCES, '/node_modules/text-encoding/index.js'] } },
    ['--budget', '100000'],
  );
  assert.equal(code, 1, out);
  assert.match(out, /text-encoding/, out);
});

test('server code in the DEFERRED chunk fails — every client chunk is in scope', () => {
  // This is the case that distinguishes the server-module assertion from the entry-chunk one.
  // A gate reading only entry-*.js.map reports clean here.
  const { code, out } = runGate(
    {
      'entry-abc.js': { size: 100, sources: CLEAN_SOURCES },
      'assistant-panel-def.js': { size: 100, sources: ['/app/src/bff-server/backup-run-summary.ts'] },
    },
    ['--budget', '100000'],
  );
  assert.equal(code, 1, out);
  assert.match(out, /bff-server/, out);
  assert.match(out, /assistant-panel-def\.js/, 'must name the chunk it was found in');
});

test('luxon in any client chunk fails', () => {
  const { code, out } = runGate(
    {
      'entry-abc.js': { size: 100, sources: CLEAN_SOURCES },
      'assistant-panel-def.js': { size: 100, sources: ['/node_modules/luxon/src/datetime.js'] },
    },
    ['--budget', '100000'],
  );
  assert.equal(code, 1, out);
  assert.match(out, /luxon/, out);
});

test('api-client in a client chunk is FINE — it is client code by design', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 100, sources: [...CLEAN_SOURCES, '/app/src/bff-server/api-client.ts'] } },
    ['--budget', '100000'],
  );
  assert.equal(code, 0, out);
});

test('a missing source map keeps the size check and reports the SKIP on its own line', () => {
  // A silent skip here would leave the whole module half of the gate proving nothing.
  const { code, out } = runGate({ 'entry-abc.js': { size: 500 } }, ['--budget', '1000']);
  assert.equal(code, 0, out);
  assert.match(out, /skip/i, 'the skip must be visible');
});

test('--json emits machine-readable output', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 500, sources: CLEAN_SOURCES } },
    ['--budget', '1000', '--json'],
  );
  assert.equal(code, 0, out);
  const parsed = JSON.parse(out);
  assert.equal(parsed.entryBytes, 500);
  assert.equal(parsed.budgetBytes, 1000);
});

test('--selftest exits 0 on a healthy gate', () => {
  const r = spawnSync('node', [GATE, '--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('an unknown flag exits 2 without scanning', () => {
  const r = spawnSync('node', [GATE, '--dry_run'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
});

test('a budget flag with no value exits 2 rather than guessing', () => {
  const r = spawnSync('node', [GATE, '--budget'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
});

test('--help exits 0 and names every flag', () => {
  const r = spawnSync('node', [GATE, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const out = `${r.stdout}${r.stderr}`;
  for (const flag of ['--dist', '--budget', '--json', '--selftest']) {
    assert.match(out, new RegExp(flag.replace('--', '--')), `usage must name ${flag}`);
  }
});

test('--require-maps turns a map-less export from a skip into a FAILURE', () => {
  // The nx target passes it. Without that, an export that stopped emitting `--source-maps` would
  // leave the byte budget as the only live assertion while the gate still printed OK.
  const bare = { 'entry-abc.js': { size: 100 } };
  assert.equal(runGate(bare, ['--budget', '1000']).code, 0, 'a skip by default');
  const { code, out } = runGate(bare, ['--budget', '1000', '--require-maps']);
  assert.equal(code, 1, out);
  assert.match(out, /source map/i, out);
  assert.match(out, /--source-maps/, 'must name the flag that fixes it');
});

test('--require-maps passes when the maps are there', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 100, sources: CLEAN_SOURCES } },
    ['--budget', '1000', '--require-maps'],
  );
  assert.equal(code, 0, out);
});
