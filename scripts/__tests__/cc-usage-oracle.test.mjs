// Feature 105 (SC-002, FR-017): the parser's per-session totals equal the reference tool's exactly.
// The oracle is committed (research R8) and regenerated only by `pnpm nx cc-usage-oracle
// infrastructure-as-code`; this compares against it, and runs the CLI's oracle-check both ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionTotals } from '../lib/cc-usage/transcript-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'cc-usage');
const CLI = resolve(HERE, '..', 'cc-usage.mjs');
const oracle = JSON.parse(readFileSync(join(FIXTURES, 'ccusage-oracle.json'), 'utf8'));

test('the oracle covers every fixture session that has a main transcript', () => {
  assert.deepEqual(Object.keys(oracle.sessions).sort(), [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ]);
});

for (const [sessionId, expected] of Object.entries(oracle.sessions)) {
  test(`parser totals equal ${oracle.tool} for ${sessionId.slice(0, 8)}`, () => {
    assert.deepEqual(sessionTotals(FIXTURES)[sessionId], expected);
  });
}

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('oracle-check exits 0 on the committed fixtures', () => {
  const r = run(['oracle-check']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('oracle-check exits 1 when one fixture usage is altered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-usage-oracle-'));
  try {
    cpSync(FIXTURES, dir, { recursive: true });
    const f = join(dir, 'projects', '-workspaces-mcm', '11111111-1111-4111-8111-111111111111.jsonl');
    writeFileSync(f, readFileSync(f, 'utf8').replaceAll('"input_tokens":10,', '"input_tokens":11,'));
    const r = run(['oracle-check', '--fixtures', dir]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /11111111.*input/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown flag is a usage error (exit 2), never a silent default', () => {
  assert.equal(run(['oracle-check', '--fixturez', '/x']).status, 2);
});
