// Feature 105 — `doctor`: capture health in ≤ 12 lines (US2-AC5, used by US1's exit check; FR-016).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envFor, hookEvent, runCli, startFakeStore, tempConfigDir, SESSION } from './cc-usage-test-support.mjs';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');

for (const missing of ['MCM_USAGE_INGEST_URL', 'MCM_USAGE_TOKEN_URL', 'MCM_USAGE_CLIENT_SECRET']) {
  test(`configured: no when ${missing} is unset`, async () => {
    const cfg = tempConfigDir();
    try {
      const env = envFor(cfg.dir, { ingestUrl: 'http://127.0.0.1:9', tokenUrl: 'http://127.0.0.1:9/token' }, { [missing]: undefined });
      const r = await runCli(['doctor'], { env });
      assert.equal(r.code, 0);
      assert.match(r.stdout, new RegExp(`configured: no \\(missing ${missing}\\)`));
    } finally {
      cfg.cleanup();
    }
  });
}

test('before any ship: never shipped, and every transcript listed as unshipped', async () => {
  const cfg = tempConfigDir();
  try {
    const r = await runCli(['doctor'], { env: envFor(cfg.dir, null, { CC_USAGE_NOW: String(NOW) }) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /last ship: never/);
    assert.match(r.stdout, /unshipped: 3 transcripts/);
    assert.match(r.stdout, /11111111/);
  } finally {
    cfg.cleanup();
  }
});

test('after a sweep: last ship, empty spool, valid token, nothing unshipped; ≤ 12 lines', async () => {
  const store = await startFakeStore();
  const cfg = tempConfigDir();
  try {
    const env = envFor(cfg.dir, store, { CC_USAGE_NOW: String(NOW) });
    await runCli(['hook'], { env, stdin: hookEvent('SessionStart', 'C', cfg.dir) });
    const r = await runCli(['doctor'], { env });
    assert.equal(r.code, 0);
    const lines = r.stdout.trim().split('\n');
    assert.ok(lines.length <= 12, `${lines.length} lines`);
    assert.match(r.stdout, /configured: yes/);
    assert.match(r.stdout, /last ship: 2026-11-21T12:00:00/);
    assert.match(r.stdout, /spool: 0 files/);
    assert.match(r.stdout, /back-off: none/);
    assert.match(r.stdout, /token: valid until 2026-11-21T13:00:00/);
    assert.match(r.stdout, /unshipped: none/);
    assert.ok(!r.stdout.includes('127.0.0.1'), 'no host in doctor output');
  } finally {
    await store.close();
    cfg.cleanup();
  }
});

test('spool depth, drops, back-off and token rejection are reported', async () => {
  const cfg = tempConfigDir();
  try {
    const u = join(cfg.dir, 'usage');
    mkdirSync(join(u, 'spool'), { recursive: true });
    writeFileSync(join(u, 'spool', `000000000000001-${SESSION.A}-1-0.ndjson`), '{"sessionId":"x"}\n');
    writeFileSync(join(u, 'spool-drops.json'), JSON.stringify([{ sessionId: SESSION.A, range: { file: 'main', from: 0, to: 9 }, at: '2026-11-21T11:00:00.000Z' }]));
    writeFileSync(join(u, 'backoff'), String(NOW - 1000));
    writeFileSync(join(u, 'token-state.json'), JSON.stringify({ state: 'rejected', at: NOW - 5000 }));
    const r = await runCli(['doctor'], { env: envFor(cfg.dir, null, { CC_USAGE_NOW: String(NOW) }) });
    assert.match(r.stdout, /spool: 1 files?, .*drops: 1 \(last 2026-11-21T11:00:00/);
    assert.match(r.stdout, /back-off: active until 2026-11-21T12:04:59/);
    assert.match(r.stdout, /token: client credential rejected/);
    writeFileSync(join(u, 'token-state.json'), JSON.stringify({ state: 'store-rejects', at: NOW - 5000 }));
    assert.match((await runCli(['doctor'], { env: envFor(cfg.dir, null, { CC_USAGE_NOW: String(NOW) }) })).stdout, /token: store rejects token/);
  } finally {
    cfg.cleanup();
  }
});
