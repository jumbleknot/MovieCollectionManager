// Feature 105, T077: a forked subagent's transcript starts from a copy of its parent's context, so it
// repeats parent assistant lines with the SAME message id. The store keys model_calls on
// (session_id, message_id): a batch holding both copies is refused (Postgres 21000, "cannot affect
// row a second time"), and a copy shipped later would re-attribute the parent's call to the subagent.
// Found by the first production sweep, 2026-11-22.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envFor, hookEvent, runCli, startFakeStore, tempConfigDir, SESSION, PROJECT } from './cc-usage-test-support.mjs';

test('a fork copy of a parent model call ships once, attributed to the parent', async () => {
  const store = await startFakeStore();
  const cfg = tempConfigDir();
  try {
    const main = join(cfg.dir, 'projects', PROJECT.A, `${SESSION.A}.jsonl`);
    const parentLine = readFileSync(main, 'utf8').split('\n')
      .find((l) => { try { const j = JSON.parse(l); return j.type === 'assistant' && j.message?.usage; } catch { return false; } });
    const parentId = JSON.parse(parentLine).message.id;
    const fork = join(cfg.dir, 'projects', PROJECT.A, SESSION.A, 'subagents', 'agent-x.jsonl');
    assert.ok(existsSync(fork), 'fixture subagent agent-x exists');
    appendFileSync(fork, `${JSON.stringify({ ...JSON.parse(parentLine), isSidechain: true, timestamp: '2026-11-10T09:30:00.000Z' })}\n`);

    const r = await runCli(['hook'], { env: envFor(cfg.dir, store), stdin: hookEvent('SessionEnd', 'A', cfg.dir) });
    assert.equal(r.code, 0);

    const spool = join(cfg.dir, 'usage', 'spool');
    assert.deepEqual(existsSync(spool) ? readdirSync(spool) : [], [], 'nothing spooled: the store accepted every batch');
    const calls = store.rows('model_calls').filter((c) => c.session_id === SESSION.A && c.message_id === parentId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agent_id, null, 'the parent keeps the call');
    for (const req of store.requests.filter((q) => q.path === '/model_calls')) {
      const ids = req.rows.map((x) => x.message_id);
      assert.equal(new Set(ids).size, ids.length, 'no batch repeats a message id');
    }
  } finally {
    cfg.cleanup();
    await store.close();
  }
});

test('summarizeSession (the oracle path) counts a fork copy once, for the parent', async () => {
  const { summarizeSession } = await import('../lib/cc-usage/parse-transcript.mjs');
  const cfg = tempConfigDir();
  try {
    const main = readFileSync(join(cfg.dir, 'projects', PROJECT.A, `${SESSION.A}.jsonl`), 'utf8');
    const parentLine = main.split('\n')
      .find((l) => { try { const j = JSON.parse(l); return j.type === 'assistant' && j.message?.usage; } catch { return false; } });
    const parentId = JSON.parse(parentLine).message.id;
    const s = summarizeSession({ sessionId: SESSION.A, projectDir: PROJECT.A, main, subagents: [{ agentId: 'fork', meta: null, transcript: `${parentLine}\n` }] });
    const hits = s.modelCalls.filter((c) => c.message_id === parentId);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].agent_id, null);
  } finally {
    cfg.cleanup();
  }
});
