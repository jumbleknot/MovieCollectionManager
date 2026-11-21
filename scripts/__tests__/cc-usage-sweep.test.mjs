// Feature 105 — the SessionStart catch-up sweep (US1-AC2, US1-AC3; FR-006, FR-011; research R4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { envFor, hookEvent, runCli, startFakeStore, tempConfigDir, SESSION } from './cc-usage-test-support.mjs';

// The fixtures are dated 2026-11-10..14; "now" is pinned well after, so every session is > 24 h old.
const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const at = (ms) => ({ CC_USAGE_NOW: String(ms) });
const postedRows = (store, table) => store.requests.filter((r) => r.path === `/${table}`).reduce((n, r) => n + r.rows.length, 0);

async function withStore(fn) {
  const store = await startFakeStore();
  const cfg = tempConfigDir();
  try {
    await fn(store, cfg.dir);
  } finally {
    await store.close();
    cfg.cleanup();
  }
}

test('a SessionStart sweep visits every project directory and ships each transcript once', () => withStore(async (store, dir) => {
  const r = await runCli(['hook'], { env: envFor(dir, store, at(NOW)), stdin: hookEvent('SessionStart', 'C', dir) });
  assert.equal(r.code, 0);
  const sessions = store.rows('sessions').map((s) => s.session_id).sort();
  assert.deepEqual(sessions, [SESSION.A, SESSION.B, SESSION.C, SESSION.D].sort(), 'both project directories swept');
  assert.equal(store.rows('model_calls').length, 15, '8 (A, incl. subagent) + 2 (B) + 5 (C)');
  assert.equal(postedRows(store, 'model_calls'), 15, 'each model call sent exactly once');
  assert.ok(existsSync(join(dir, 'usage', 'state', `${SESSION.B}.json`)), 'a transcript with no prior state was backfilled');
}));

test('a transcript silent for over 24 h with no SessionEnd becomes partial / inferred-stale', () => withStore(async (store, dir) => {
  await runCli(['hook'], { env: envFor(dir, store, at(NOW)), stdin: hookEvent('SessionStart', 'C', dir) });
  const b = store.rows('sessions').find((s) => s.session_id === SESSION.B);
  assert.equal(b.capture_status, 'partial');
  assert.ok(b.partial_reasons.includes('no-session-end'));
  assert.equal(b.end_reason, 'inferred-stale');
  assert.equal(b.ended_at, '2026-11-12T14:00:10.000Z', 'ended at its last line');
  const d = store.rows('sessions').find((s) => s.session_id === SESSION.D);
  assert.equal(d.capture_status, 'not_captured');
}));

test('a second sweep within 15 min is skipped; after that, nothing already shipped is resent', () => withStore(async (store, dir) => {
  await runCli(['hook'], { env: envFor(dir, store, at(NOW)), stdin: hookEvent('SessionStart', 'C', dir) });
  const n = store.requests.length;
  await runCli(['hook'], { env: envFor(dir, store, at(NOW + 5 * 60_000)), stdin: hookEvent('SessionStart', 'C', dir) });
  assert.equal(store.requests.length, n, 'skipped inside 15 min');
  await runCli(['hook'], { env: envFor(dir, store, at(NOW + 16 * 60_000)), stdin: hookEvent('SessionStart', 'C', dir) });
  assert.equal(postedRows(store, 'model_calls'), 15, 'no model call resent by a later sweep');
}));

test('an interrupted sweep resumes from the stored offsets', () => withStore(async (store, dir) => {
  const env = envFor(dir, store, { ...at(NOW), CC_USAGE_TEST_SWEEP_MAX_SESSIONS: '1' });
  await runCli(['hook'], { env, stdin: hookEvent('SessionStart', 'C', dir) });
  const partial = store.rows('model_calls').length;
  assert.ok(partial > 0 && partial < 15, `the interrupted sweep shipped some, not all (${partial})`);
  await runCli(['hook'], { env: envFor(dir, store, at(NOW + 60_000)), stdin: hookEvent('SessionStart', 'C', dir) });
  assert.equal(store.rows('model_calls').length, 15, 'the next sweep finished the job');
  assert.equal(postedRows(store, 'model_calls'), 15, 'without resending what was already shipped');
}));
