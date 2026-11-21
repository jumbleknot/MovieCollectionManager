// Feature 105 — overlap safety (US1-AC5; FR-008, FR-009, SC-003): five hook processes at once end
// with exactly the rows and totals one serial run produces, and two flushers on one spool deliver
// each batch exactly once in effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { envFor, hookEvent, runCli, startFakeStore, tempConfigDir } from './cc-usage-test-support.mjs';

const NOW = String(Date.parse('2026-11-21T12:00:00.000Z'));
const TABLES = ['sessions', 'model_calls', 'turns', 'tool_use', 'skill_use'];

function snapshot(store) {
  const counts = Object.fromEntries(TABLES.map((t) => [t, store.rows(t).length]));
  const totals = {};
  for (const c of store.rows('model_calls')) {
    const s = (totals[c.session_id] ??= { input: 0, output: 0, read: 0, write: 0 });
    s.input += c.input_tokens;
    s.output += c.output_tokens;
    s.read += c.cache_read_tokens;
    s.write += c.cache_write_5m_tokens + c.cache_write_1h_tokens;
  }
  const toolCalls = store.rows('tool_use').reduce((n, r) => n + r.calls, 0);
  return { counts, totals, toolCalls };
}

async function serialRun() {
  const store = await startFakeStore();
  const cfg = tempConfigDir();
  try {
    await runCli(['hook'], { env: envFor(cfg.dir, store, { CC_USAGE_NOW: NOW }), stdin: hookEvent('SessionStart', 'C', cfg.dir) });
    return snapshot(store);
  } finally {
    await store.close();
    cfg.cleanup();
  }
}

test('5 parallel hook processes produce the same rows and totals as one serial run', async () => {
  const expected = await serialRun();
  assert.ok(expected.counts.model_calls > 0);
  const store = await startFakeStore();
  const cfg = tempConfigDir();
  try {
    const env = envFor(cfg.dir, store, { CC_USAGE_NOW: NOW, CC_USAGE_SHIP_INTERVAL_S: '0' });
    const events = [['SessionStart', 'C'], ['Stop', 'A'], ['SessionStart', 'A'], ['Stop', 'B'], ['Stop', 'A']];
    await Promise.all(events.map(([e, k]) => runCli(['hook'], { env, stdin: hookEvent(e, k, cfg.dir) })));
    // A Stop that lost a session lock to another process left that session to the sweep; one more
    // SessionStart after the interval settles everything — exactly what the next real session does.
    await runCli(['hook'], { env: envFor(cfg.dir, store, { CC_USAGE_NOW: String(Number(NOW) + 16 * 60_000) }), stdin: hookEvent('SessionStart', 'C', cfg.dir) });
    assert.deepEqual(snapshot(store), expected, 'parallel row count != serial row count');
  } finally {
    await store.close();
    cfg.cleanup();
  }
});

test('two flushers on one spool deliver each batch exactly once in effect', async () => {
  const expected = await serialRun();
  const down = await startFakeStore({ failTables: ['sessions'] });
  const cfg = tempConfigDir();
  let downOpen = true;
  try {
    // Store failing: the sweep spools every session's batch.
    await runCli(['hook'], { env: envFor(cfg.dir, down, { CC_USAGE_NOW: NOW }), stdin: hookEvent('SessionStart', 'C', cfg.dir) });
    const spool = join(cfg.dir, 'usage', 'spool');
    assert.ok(readdirSync(spool).length > 0, 'batches were spooled');
    await down.close();
    downOpen = false;
    const up = await startFakeStore();
    try {
      // Back-off has expired; two SessionStarts flush the same spool directory at once.
      const env = envFor(cfg.dir, up, { CC_USAGE_NOW: String(Number(NOW) + 16 * 60_000) });
      await Promise.all([1, 2].map(() => runCli(['hook'], { env, stdin: hookEvent('SessionStart', 'A', cfg.dir) })));
      assert.deepEqual(snapshot(up), expected);
      assert.deepEqual(existsSync(spool) ? readdirSync(spool) : [], [], 'the spool drained');
    } finally {
      await up.close();
    }
  } finally {
    if (downOpen) await down.close();
    cfg.cleanup();
  }
});
