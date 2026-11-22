// Feature 105 — shipping records to the store (contracts/store-http.md "Writes"; US1-AC4;
// FR-008, FR-010, FR-015). Unit tier: fetch and the token source are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ON_CONFLICT, sendBatches, shipRecords } from '../lib/cc-usage/ship-records.mjs';
import { backoffActive, paths, spoolClaim } from '../lib/cc-usage/local-state.mjs';
import { CONNECT_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from '../lib/cc-usage/timed-fetch.mjs';

const INGEST = 'http://store.invalid:19040';
const TOKEN = 'tok-SECRET-access-token';
const SID = '11111111-1111-4111-8111-111111111111';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-usage-ship-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function recorder({ failOn } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ table: u.pathname.slice(1), url: u, init, rows: JSON.parse(init.body) });
    if (failOn && u.pathname === `/${failOn}`) return new Response('boom', { status: 503 });
    return new Response(null, { status: 201 });
  };
  return { fetch, calls };
}

const records = (n = 3) => ({
  session: { session_id: SID, project_dir: '-workspaces-mcm', capture_status: 'partial', partial_reasons: [], compactions: 0, parser_version: 1 },
  modelCalls: Array.from({ length: n }, (_, i) => ({
    session_id: SID, message_id: `msg_${i}`, request_id: `req_${i}`, turn_seq: 1, agent_id: null, ts: '2026-11-10T09:00:00.000Z',
    model: 'm', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, thinking_tokens: null, skill: null,
  })),
  turns: [{ session_id: SID, turn_seq: 1, origin: 'human', started_at: 'x', ended_at: 'x', idle_gap_s: 0, context_tokens_at_start: 1, areas: [], rereads: 0 }],
  toolUse: [{ session_id: SID, turn_seq: 1, tool: 'Bash', command_family: 'git', calls: 1, result_bytes: 3, rtk_calls: 0, subagent_type: null }],
  skillUse: [{ session_id: SID, skill: 'speckit-plan', invocations: 1, first_turn: 1 }],
});

const opts = (dir, rec, extra = {}) => ({
  configDir: dir, ingestUrl: INGEST, fetch: rec.fetch, getToken: async () => TOKEN, sessionId: SID,
  range: { file: 'main', from: 0, to: 10 }, now: 1_000_000, ...extra,
});

test('one POST per table, upsert headers and the natural on_conflict keys', () => withDir(async (dir) => {
  const rec = recorder();
  const r = await shipRecords(records(), opts(dir, rec));
  assert.deepEqual(r, { ok: true, spooled: false });
  for (const c of rec.calls) {
    assert.equal(c.init.method, 'POST');
    const h = new Headers(c.init.headers);
    assert.equal(h.get('prefer'), 'resolution=merge-duplicates,return=minimal');
    assert.equal(h.get('content-type'), 'application/json');
    assert.equal(h.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(c.url.searchParams.get('on_conflict'), ON_CONFLICT[c.table]);
    assert.ok(c.init.signal, 'every request has a timeout signal');
  }
  assert.deepEqual(ON_CONFLICT, {
    sessions: 'session_id', features: 'feature_id', turns: 'session_id,turn_seq',
    model_calls: 'session_id,message_id', tool_use: 'session_id,turn_seq,tool,command_family', skill_use: 'session_id,skill',
  });
}));

test('parents first: sessions before turns, model calls, tool use and skill use', () => withDir(async (dir) => {
  const rec = recorder();
  await shipRecords(records(), opts(dir, rec));
  assert.deepEqual(rec.calls.map((c) => c.table), ['sessions', 'turns', 'model_calls', 'tool_use', 'skill_use']);
}));

test('batch caps: 1,200 model calls go as 500 + 500 + 200', () => withDir(async (dir) => {
  const rec = recorder();
  await shipRecords(records(1200), opts(dir, rec));
  assert.deepEqual(rec.calls.filter((c) => c.table === 'model_calls').map((c) => c.rows.length), [500, 500, 200]);
}));

test('rows sharing an on_conflict key are sent once per batch, first wins (Postgres 21000; T077)', () => withDir(async (dir) => {
  const rec = recorder();
  const r = records(3);
  r.modelCalls.push({ ...r.modelCalls[1], agent_id: 'fork-copy', turn_seq: 9 });
  await shipRecords(r, opts(dir, rec));
  const sent = rec.calls.filter((c) => c.table === 'model_calls').flatMap((c) => c.rows);
  assert.deepEqual(sent.map((x) => x.message_id), ['msg_0', 'msg_1', 'msg_2']);
  assert.equal(sent[1].agent_id, null, 'the first occurrence is kept');
}));

test('rows with different key sets go in separate POSTs (PostgREST PGRST102), never null-filled', () => withDir(async (dir) => {
  const rec = recorder();
  await sendBatches({ features: [
    { feature_id: 'a@2026-11-01', branch: 'a', first_seen_at: '2026-11-01T00:00:00Z' },
    { feature_id: 'b@2026-11-01', branch: 'b', first_seen_at: '2026-11-01T00:00:00Z', kind: 'spec', spec_dir: 'specs/b' },
    { feature_id: 'c@2026-11-01', branch: 'c', first_seen_at: '2026-11-01T00:00:00Z' },
  ] }, opts(dir, rec));
  const posts = rec.calls.filter((c) => c.table === 'features');
  assert.equal(posts.length, 2);
  for (const p of posts) assert.equal(new Set(p.rows.map((r) => Object.keys(r).sort().join())).size, 1, 'one key set per POST');
  assert.ok(posts.flatMap((p) => p.rows).every((r) => !Object.values(r).includes(undefined)));
}));

test('every batch goes through the privacy allowlist', () => withDir(async (dir) => {
  const rec = recorder();
  const r = records();
  r.turns[0].command = 'SENTINEL-command-1';
  await shipRecords(r, opts(dir, rec));
  assert.ok(!JSON.stringify(rec.calls.map((c) => c.rows)).includes('SENTINEL'), 'a smuggled field shipped');
}));

test('a failure mid-ship spools the WHOLE batch and writes back-off', () => withDir(async (dir) => {
  const rec = recorder({ failOn: 'model_calls' });
  const r = await shipRecords(records(), opts(dir, rec));
  assert.deepEqual(r, { ok: false, spooled: true, reason: 'store 503' });
  assert.equal(backoffActive(dir, { now: 1_000_001 }), true);
  const [claim] = spoolClaim(dir, { sessionId: SID, now: 1_000_001 });
  assert.deepEqual(Object.keys(claim.entry.batches).sort(), ['model_calls', 'sessions', 'skill_use', 'tool_use', 'turns']);
  assert.equal(claim.entry.batches.sessions.length, 1, 'parents already sent are spooled too');
  assert.deepEqual(claim.entry.range, { file: 'main', from: 0, to: 10 });
}));

test('a spooled batch replays through sendBatches unchanged', () => withDir(async (dir) => {
  await shipRecords(records(), opts(dir, recorder({ failOn: 'turns' })));
  const [claim] = spoolClaim(dir, { sessionId: SID, now: 1_000_001 });
  const rec = recorder();
  const r = await sendBatches(claim.entry.batches, opts(dir, rec, { spoolOnFailure: false }));
  assert.equal(r.ok, true);
  assert.equal(rec.calls.length, 5);
}));

test('a store 401 records the rejection and spools', () => withDir(async (dir) => {
  const fetch = async () => new Response('', { status: 401 });
  const r = await shipRecords(records(), opts(dir, { fetch }));
  assert.equal(r.spooled, true);
  assert.equal(JSON.parse(readFileSync(paths(dir).tokenState, 'utf8')).state, 'store-rejects');
}));

test('a token failure spools without touching the store', () => withDir(async (dir) => {
  const rec = recorder();
  const getToken = async () => { const e = new Error('token endpoint unreachable'); e.kind = 'network'; throw e; };
  const r = await shipRecords(records(), opts(dir, rec, { getToken }));
  assert.equal(r.spooled, true);
  assert.equal(rec.calls.length, 0);
}));

test('the token never reaches the log or a returned reason', () => withDir(async (dir) => {
  const r = await shipRecords(records(), opts(dir, { fetch: async () => { throw new TypeError(`fetch failed ${TOKEN}`); } }));
  const logText = existsSync(paths(dir).log) ? readFileSync(paths(dir).log, 'utf8') : '';
  assert.ok(!logText.includes(TOKEN));
  assert.ok(!JSON.stringify(r).includes(TOKEN));
}));

test('connect timeout 2 s and total 5 s; a hanging store is abandoned at the connect bound', () => withDir(async (dir) => {
  assert.equal(CONNECT_TIMEOUT_MS, 2000);
  assert.equal(TOTAL_TIMEOUT_MS, 5000);
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const t0 = performance.now();
  const r = await shipRecords(records(), opts(dir, { fetch: hang }));
  const ms = performance.now() - t0;
  assert.equal(r.spooled, true);
  assert.ok(ms >= 1900 && ms < 3000, `abandoned after ${Math.round(ms)} ms`);
}));
