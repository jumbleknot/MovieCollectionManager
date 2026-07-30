// Unit tests for the wiki maintenance orchestrator (scripts/wiki-maintain.mjs) — feature 044.
//
// Deterministic, offline, token-free, `node:` built-ins + `yaml` only. CI-enforced on every push by
// the `guardrails / naming` job's shell-expanded `node --test scripts/__tests__/*.test.mjs` glob,
// which runs in a container with no forge access, no network, and no ANTHROPIC_API_KEY.
//
// Two facts from the feature's Phase 0 research shape almost every assertion here:
//   R1 — the generator reports NO token or cost data, so budgets are pages + wall-clock, observed.
//   R2 — the generator has NO programmatic scoping surface. A slice is free text in a run message,
//        so the page cap is advisory and VERIFICATION IS THE ONLY ENFORCEMENT THAT EXISTS. Anything
//        below that trusts the generator's own account of what it did is a bug, not a shortcut.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'wiki-maintain.mjs');

const mod = await import(SCRIPT);

function tmpBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-maintain-'));
  mkdirSync(join(dir, 'openwiki'), { recursive: true });
  return dir;
}

// ── E3: the run record ──────────────────────────────────────────────────────────

test('run record round-trips through openwiki/.maintenance-state.json', () => {
  const root = tmpBundle();
  try {
    const record = {
      coveredCommit: 'a'.repeat(40),
      coveredAt: '2026-07-30T12:00:00.000Z',
      lastOutcome: 'completed',
      backlog: [{ area: 'gotchas', pages: ['x.md'], areaExists: true, reason: 'source changed' }],
      proposal: { branch: 'wiki-maintenance', number: 42, headCommit: 'b'.repeat(40) },
      lastRunBudget: { pagesWritten: 8, elapsedSeconds: 610, stoppedAtBudget: false },
    };
    mod.writeRunRecord(root, record);

    const onDisk = join(root, 'openwiki', '.maintenance-state.json');
    assert.ok(statSync(onDisk).isFile(), 'the record must live at openwiki/.maintenance-state.json');

    const read = mod.readRunRecord(root);
    assert.deepEqual(read, record);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an absent run record reads as never-covered rather than as an error', () => {
  const root = tmpBundle();
  try {
    const record = mod.readRunRecord(root);
    assert.equal(record.coveredCommit, null, 'never covered must be distinguishable from covered');
    assert.equal(record.lastOutcome, null);
    assert.deepEqual(record.backlog, []);
    assert.equal(record.proposal, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lastOutcome accepts exactly the three outcomes FR-017 requires distinguishing', () => {
  const root = tmpBundle();
  try {
    assert.deepEqual([...mod.RUN_OUTCOMES].sort(), ['completed', 'failed', 'nothing-to-do']);
    for (const outcome of mod.RUN_OUTCOMES) {
      mod.writeRunRecord(root, { coveredCommit: 'c'.repeat(40), lastOutcome: outcome });
      assert.equal(mod.readRunRecord(root).lastOutcome, outcome);
    }
    assert.throws(
      () => mod.writeRunRecord(root, { coveredCommit: 'c'.repeat(40), lastOutcome: 'probably-fine' }),
      /lastOutcome/,
      'an outcome outside the enum must be rejected at write time',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed run record is a hard error, never a silent default', () => {
  const root = tmpBundle();
  try {
    writeFileSync(join(root, 'openwiki', '.maintenance-state.json'), '{ "coveredCommit": "abc",,, }');
    assert.throws(() => mod.readRunRecord(root), /\.maintenance-state\.json/);

    // Parseable JSON of the wrong shape is equally unsafe: silently defaulting would re-cover
    // history that was already covered, or skip history that never was.
    writeFileSync(join(root, 'openwiki', '.maintenance-state.json'), '["not", "an", "object"]');
    assert.throws(() => mod.readRunRecord(root), /\.maintenance-state\.json/);

    writeFileSync(join(root, 'openwiki', '.maintenance-state.json'), '{"lastOutcome":"fine"}');
    assert.throws(() => mod.readRunRecord(root), /lastOutcome/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The tool owns openwiki/.last-update.json. Feature 043 measured it advancing ONLY when wiki content
// changed — precisely the behaviour that made the free "nothing to document" path unreachable — so
// repurposing it would reintroduce the defect this feature exists to fix (data-model E3).
test('the module never reads or writes the tool-owned .last-update.json', () => {
  const root = tmpBundle();
  try {
    const toolFile = join(root, 'openwiki', '.last-update.json');
    const toolContent = JSON.stringify({ updatedAt: '2026-07-27T20:42:02.048Z', command: 'update' });
    writeFileSync(toolFile, toolContent);

    mod.writeRunRecord(root, { coveredCommit: 'd'.repeat(40), lastOutcome: 'nothing-to-do' });
    mod.readRunRecord(root);

    assert.equal(readFileSync(toolFile, 'utf8'), toolContent, '.last-update.json must be untouched');

    const source = readFileSync(SCRIPT, 'utf8');
    const mentions = source.split('\n').filter((l) => l.includes('.last-update.json') && !l.trimStart().startsWith('//'));
    assert.deepEqual(mentions, [], 'the tool-owned file must not appear in executable code, only in comments');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
