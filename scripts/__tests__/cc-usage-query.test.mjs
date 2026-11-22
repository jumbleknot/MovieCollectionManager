// Feature 105 US2 — the interactive commands (contracts/cli.md "Interactive commands"; US2-AC1..AC4;
// FR-018..FR-022, SC-006). T036. The store is the in-process fake; filters are asserted on the query
// the command SENT (PostgREST applies them in production, the integration tier proves that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeSession } from '../lib/cc-usage/parse-transcript.mjs';
import { readSessionState } from '../lib/cc-usage/local-state.mjs';
import { envFor, hookEvent, runCli, startFakeStore, tempConfigDir, SESSION, PROJECT } from './cc-usage-test-support.mjs';

const UNREACHABLE = 'http://127.0.0.1:9';
const offline = (dir) => envFor(dir, { ingestUrl: UNREACHABLE, tokenUrl: `${UNREACHABLE}/token` });

/** Expected totals for one fixture session, from the whole-transcript parser. */
function expected(dir, key) {
  const base = join(dir, 'projects', PROJECT[key]);
  const main = readFileSync(join(base, `${SESSION[key]}.jsonl`));
  let sub = null;
  try { sub = readFileSync(join(base, SESSION[key], 'subagents', 'agent-x.jsonl')); } catch { /* none */ }
  const s = summarizeSession({ sessionId: SESSION[key], projectDir: PROJECT[key], main, subagents: sub ? [{ agentId: 'x', meta: null, transcript: sub }] : [] });
  const sum = (f, pred = () => true) => s.modelCalls.filter(pred).reduce((n, c) => n + f(c), 0);
  const all = (c) => c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_5m_tokens + c.cache_write_1h_tokens;
  return { input: sum((c) => c.input_tokens), output: sum((c) => c.output_tokens), total: sum(all), sub: sum(all, (c) => c.agent_id !== null) };
}

async function withStore(fn, opts) {
  const store = await startFakeStore(opts);
  const cfg = tempConfigDir();
  try {
    await fn(store, cfg.dir);
  } finally {
    cfg.cleanup();
    await store.close();
  }
}

test('now --session answers from local state with the store unreachable, in under 5 s (SC-006)', () => withStore(async (_store, dir) => {
  const r = await runCli(['now', '--session', SESSION.A, '--json'], { env: offline(dir) });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.ms < 5000, `${Math.round(r.ms)} ms`);
  const j = JSON.parse(r.stdout);
  const e = expected(dir, 'A');
  assert.equal(j.session_id, SESSION.A);
  assert.equal(j.tokens.input, e.input);
  assert.equal(j.tokens.output, e.output);
  assert.equal(j.tokens.total, e.total);
  assert.equal(j.subagent_share, e.total ? Math.round((e.sub / e.total) * 1000) / 1000 : 0);
  assert.ok(j.context_now > 0, 'context now');
  assert.ok(Array.isArray(j.top_tools) && j.top_tools.length > 0 && j.top_tools.length <= 5);
  assert.equal(j.recent_median, null, 'no median when the store is unreachable');
}));

test('now after a ship reads the stored summary plus the unshipped tail, and gives the same numbers', () => withStore(async (store, dir) => {
  const env = envFor(dir, store);
  await runCli(['hook'], { env, stdin: hookEvent('SessionEnd', 'A', dir) });
  assert.ok(readSessionState(dir, SESSION.A)?.summary, 'shipping keeps an incremental summary');
  const r = await runCli(['now', '--session', SESSION.A, '--json'], { env: offline(dir) });
  assert.equal(JSON.parse(r.stdout).tokens.total, expected(dir, 'A').total);
}));

test('with the store reachable, now adds the median of recent sessions, excluding itself', () => withStore(async (store, dir) => {
  const r = await runCli(['now', '--session', SESSION.A, '--json'], { env: envFor(dir, store) });
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.recent_median, { tokens: 300, n: 3 });
  const q = store.requests.find((x) => x.path === '/v_session_totals');
  assert.match(q.query, /order=started_at\.desc/);
  assert.match(q.query, /session_id=neq\./);
}, { views: { v_session_totals: [100, 300, 900].map((t, i) => ({ session_id: `s${i}`, input_tokens: t, output_tokens: 0, cache_read_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0 })) } }));

test('two live sessions: each now shows only its own', () => withStore(async (_s, dir) => {
  const a = JSON.parse((await runCli(['now', '--session', SESSION.A, '--json'], { env: offline(dir) })).stdout);
  const b = JSON.parse((await runCli(['now', '--session', SESSION.B, '--json'], { env: offline(dir) })).stdout);
  assert.equal(a.tokens.total, expected(dir, 'A').total);
  assert.equal(b.tokens.total, expected(dir, 'B').total);
  assert.notEqual(a.tokens.total, b.tokens.total);
}));

test('now prints a compact table by default', () => withStore(async (_s, dir) => {
  const r = await runCli(['now', '--session', SESSION.A], { env: offline(dir) });
  assert.match(r.stdout, /^session 11111111/m);
  assert.match(r.stdout, /context now/);
  assert.match(r.stdout, /top tool outputs/);
}));

const SESSIONS = [
  { session_id: SESSION.A, started_at: '2026-11-10T09:00:00Z', starting_branch: 'main', turns: 2, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_5m_tokens: 0, cache_write_1h_tokens: 40, main_tokens: 90, subagent_tokens: 10, manual_tag: null, areas: ['docs'] },
  { session_id: SESSION.B, started_at: '2026-11-17T09:00:00Z', starting_branch: 'feat-a', turns: 1, input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_5m_tokens: 0, cache_write_1h_tokens: 4, main_tokens: 10, subagent_tokens: 0, manual_tag: 'wip', areas: ['scripts'] },
];

test('sessions sends the branch, area and window filters and renders one row per session', () => withStore(async (store, dir) => {
  const r = await runCli(['sessions', '--since', '7d', '--branch', 'main', '--area', 'docs'], { env: envFor(dir, store, { CC_USAGE_NOW: '2026-11-21T00:00:00Z' }) });
  assert.equal(r.code, 0, r.stderr);
  const q = store.requests.find((x) => x.path === '/v_session_totals').query;
  assert.match(q, /starting_branch=eq\.main/);
  assert.match(decodeURIComponent(q), /areas=cs\.\{docs\}/);
  assert.match(q, /started_at=gte\.2026-11-14T00%3A00%3A00\.000Z|started_at=gte\.2026-11-14T00:00:00\.000Z/);
  assert.match(r.stdout, /11111111/);
  assert.doesNotMatch(r.stdout, /22222222/, 'the branch filter excludes the feat-a session');
}, { views: { v_session_totals: SESSIONS } }));

test('trend --by week buckets sessions by ISO week; --by area sums turns per area', () => withStore(async (store, dir) => {
  const w = await runCli(['trend', '--by', 'week', '--json'], { env: envFor(dir, store) });
  const weeks = JSON.parse(w.stdout);
  assert.deepEqual(weeks.map((x) => [x.week, x.sessions, x.tokens]), [['2026-11-09', 1, 100], ['2026-11-16', 1, 10]]);
  const a = await runCli(['trend', '--by', 'area', '--json'], { env: envFor(dir, store) });
  const areas = JSON.parse(a.stdout);
  assert.deepEqual(areas.map((x) => [x.area, x.turns, x.tokens]), [['docs', 2, 15], ['scripts', 1, 5]]);
}, { views: {
  v_session_totals: SESSIONS,
  v_turn_totals: [
    { session_id: SESSION.A, turn_seq: 1, started_at: '2026-11-10T09:00:00Z', areas: ['docs'], input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0 },
    { session_id: SESSION.A, turn_seq: 2, started_at: '2026-11-10T09:10:00Z', areas: ['docs', 'scripts'], input_tokens: 5, output_tokens: 0, cache_read_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0 },
  ],
} }));

test('compare puts two sessions side by side', () => withStore(async (store, dir) => {
  const r = await runCli(['compare', SESSION.A, SESSION.B, '--json'], { env: envFor(dir, store) });
  assert.equal(r.code, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  const total = rows.find((x) => x.metric === 'total tokens');
  assert.deepEqual([total.a, total.b], [100, 10]);
}, { views: { v_session_totals: SESSIONS } }));

test('history commands with the store unreachable print exactly one line and exit 0', () => withStore(async (_s, dir) => {
  for (const args of [['sessions'], ['trend', '--by', 'week'], ['compare', SESSION.A, SESSION.B]]) {
    const r = await runCli(args, { env: offline(dir) });
    assert.equal(r.code, 0, args.join(' '));
    assert.equal(r.stdout.trim(), 'usage history: store unreachable (spooled 0)', args.join(' '));
  }
}));

test('now, sync and tag without --session exit 2', () => withStore(async (_s, dir) => {
  for (const args of [['now'], ['sync'], ['tag', 'wip']]) {
    const r = await runCli(args, { env: offline(dir) });
    assert.equal(r.code, 2, args.join(' '));
  }
}));

test('sync --session ships at once despite a fresh interval, and resets the timer', () => withStore(async (store, dir) => {
  const env = envFor(dir, store, { CC_USAGE_NOW: '2026-11-21T10:00:00Z' });
  await runCli(['hook'], { env, stdin: hookEvent('Stop', 'A', dir) });
  const before = store.requests.filter((x) => x.path === '/sessions').length;
  // New activity after the first ship: one more model call in the main transcript.
  const main = join(dir, 'projects', PROJECT.A, `${SESSION.A}.jsonl`);
  const last = readFileSync(main, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((j) => j?.type === 'assistant' && j.message?.usage).at(-1);
  appendFileSync(main, `${JSON.stringify({ ...last, uuid: '00000000-0000-4000-8000-0000000000ff', message: { ...last.message, id: 'msg_sync_new' } })}\n`);
  const later = envFor(dir, store, { CC_USAGE_NOW: '2026-11-21T10:01:00Z' });
  await runCli(['hook'], { env: later, stdin: hookEvent('Stop', 'A', dir) });
  assert.equal(store.requests.filter((x) => x.path === '/sessions').length, before, 'Stop inside the interval does not ship');
  const r = await runCli(['sync', '--session', SESSION.A], { env: later });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(store.requests.filter((x) => x.path === '/sessions').length, before + 1);
  assert.equal(readSessionState(dir, SESSION.A).lastShipAt, Date.parse('2026-11-21T10:01:00Z'));
}));

test('tag --session patches sessions.manual_tag', () => withStore(async (store, dir) => {
  const r = await runCli(['tag', '--session', SESSION.A, 'refactor-x'], { env: envFor(dir, store) });
  assert.equal(r.code, 0, r.stderr);
  const p = store.requests.find((x) => x.method === 'PATCH');
  assert.equal(p.path, '/sessions');
  assert.match(p.query, new RegExp(`session_id=eq\\.${SESSION.A}`));
  assert.deepEqual(p.rows, { manual_tag: 'refactor-x' });
}));
