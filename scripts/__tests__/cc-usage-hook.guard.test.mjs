// Guard (feature 105; US1-AC1, US1-AC4; FR-001, FR-007, FR-011, SC-005): the hook never disturbs
// the session. Every path exits 0 with EMPTY stdout (SessionStart stdout would enter Claude's
// context) and empty stderr; a Stop inside the ship interval does no parse and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { envFor, hookEvent, runCli, startFakeStore, tempConfigDir, SESSION } from './cc-usage-test-support.mjs';

async function closedPort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function assertSilent(r, what) {
  assert.equal(r.code, 0, `${what}: exit ${r.code}`);
  assert.equal(r.stdout, '', `${what}: stdout must be empty`);
  assert.equal(r.stderr, '', `${what}: stderr must be empty`);
}

for (const event of ['SessionStart', 'Stop', 'SessionEnd']) {
  test(`${event}: exit 0, nothing on stdout or stderr, records shipped`, async () => {
    const store = await startFakeStore();
    const { dir, cleanup } = tempConfigDir();
    try {
      const r = await runCli(['hook'], { env: envFor(dir, store), stdin: hookEvent(event, 'A', dir, { reason: 'prompt_input_exit' }) });
      assertSilent(r, event);
      assert.ok(store.rows('model_calls').some((c) => c.session_id === SESSION.A), `${event} shipped session A`);
    } finally {
      await store.close();
      cleanup();
    }
  });
}

test('malformed stdin, empty stdin and an unreadable transcript: still silent and 0', async () => {
  const store = await startFakeStore();
  const { dir, cleanup } = tempConfigDir();
  try {
    const env = envFor(dir, store);
    assertSilent(await runCli(['hook'], { env, stdin: '{not json' }), 'malformed');
    assertSilent(await runCli(['hook'], { env, stdin: '' }), 'empty');
    const missing = JSON.stringify({ hook_event_name: 'Stop', session_id: '99999999-9999-4999-8999-999999999999', transcript_path: join(dir, 'projects', 'x', 'nope.jsonl'), cwd: '/x' });
    assertSilent(await runCli(['hook'], { env, stdin: missing }), 'missing transcript');
  } finally {
    await store.close();
    cleanup();
  }
});

test('not configured: nothing parsed, nothing spooled, silent', async () => {
  const { dir, cleanup } = tempConfigDir();
  try {
    const r = await runCli(['hook'], { env: envFor(dir, null), stdin: hookEvent('SessionEnd', 'A', dir) });
    assertSilent(r, 'unconfigured');
    assert.equal(existsSync(join(dir, 'usage', 'spool')), false, 'no spool when not configured (FR-010)');
    assert.equal(existsSync(join(dir, 'usage', 'state', `${SESSION.A}.json`)), false, 'no parse when not configured');
  } finally {
    cleanup();
  }
});

test('an unreachable store and an unreachable token endpoint: silent, 0, batch spooled', async () => {
  const port = await closedPort();
  for (const which of ['store', 'token']) {
    const real = await startFakeStore();
    const { dir, cleanup } = tempConfigDir();
    try {
      const store = which === 'store'
        ? { ingestUrl: `http://127.0.0.1:${port}`, tokenUrl: real.tokenUrl }
        : { ingestUrl: real.ingestUrl, tokenUrl: `http://127.0.0.1:${port}/token` };
      const r = await runCli(['hook'], { env: envFor(dir, store), stdin: hookEvent('SessionEnd', 'A', dir) });
      assertSilent(r, `unreachable ${which}`);
      assert.ok(existsSync(join(dir, 'usage', 'spool')), `spooled after unreachable ${which}`);
    } finally {
      await real.close();
      cleanup();
    }
  }
});

test('a Stop inside the ship interval does no parse and no network, in under 1 s', async () => {
  const store = await startFakeStore();
  const { dir, cleanup } = tempConfigDir();
  try {
    const trace = join(dir, 'trace.log');
    const env = envFor(dir, store, { CC_USAGE_SHIP_INTERVAL_S: '900', CC_USAGE_TEST_TRACE: trace });
    assertSilent(await runCli(['hook'], { env, stdin: hookEvent('Stop', 'A', dir) }), 'first Stop');
    const before = readFileSync(trace, 'utf8');
    assert.match(before, /parse/, 'the first Stop parsed (the trace hook works)');
    assert.match(before, /fetch/, 'the first Stop used the network (the trace hook works)');
    const requestsBefore = store.requests.length;
    const r = await runCli(['hook'], { env, stdin: hookEvent('Stop', 'A', dir) });
    assertSilent(r, 'second Stop');
    assert.equal(readFileSync(trace, 'utf8'), before, 'no parse and no fetch inside the interval');
    assert.equal(store.requests.length, requestsBefore);
    assert.ok(r.ms < 1000, `Stop took ${Math.round(r.ms)} ms`);
  } finally {
    await store.close();
    cleanup();
  }
});

test('SessionEnd records end_reason', async () => {
  const store = await startFakeStore();
  const { dir, cleanup } = tempConfigDir();
  try {
    await runCli(['hook'], { env: envFor(dir, store), stdin: hookEvent('SessionEnd', 'A', dir, { reason: 'prompt_input_exit' }) });
    const [s] = store.rows('sessions').filter((x) => x.session_id === SESSION.A);
    assert.equal(s.end_reason, 'prompt_input_exit');
    assert.ok(s.ended_at);
  } finally {
    await store.close();
    cleanup();
  }
});
