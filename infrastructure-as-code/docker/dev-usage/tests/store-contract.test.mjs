// Feature 105 — the store contract, against a REAL Postgres + PostgREST + Keycloak (no mocks;
// constitution "Test Type Integrity"). Run through `pnpm nx dev-usage-integration
// infrastructure-as-code`, which brings the stack up and passes its URLs and secrets in DEV_USAGE_IT_*.
// Without them every test SKIPS — unless MCM_REQUIRE_LIVE_STACK=1, which makes that a failure.
// (US1-AC1, US1-AC5; FR-008, FR-013, FR-014, SC-003; contracts/store-http.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { obtainAccessToken } from '../../../../scripts/lib/cc-usage/obtain-access-token.mjs';
import { sendBatches } from '../../../../scripts/lib/cc-usage/ship-records.mjs';
import { sessionTotals } from '../../../../scripts/lib/cc-usage/transcript-files.mjs';
import { FIXTURES, SESSION, envFor, hookEvent, runCli, tempConfigDir } from '../../../../scripts/__tests__/cc-usage-test-support.mjs';

const E = process.env;
const live = Boolean(E.DEV_USAGE_IT_INGEST_URL);
const requireLive = E.MCM_REQUIRE_LIVE_STACK === '1';
const opts = live ? {} : { skip: requireLive ? false : 'store stack not running (use `pnpm nx dev-usage-integration infrastructure-as-code`)' };
const it = (name, fn) => test(name, opts, async () => {
  if (!live) assert.fail('MCM_REQUIRE_LIVE_STACK=1 but the store stack is not running — run it through `pnpm nx dev-usage-integration infrastructure-as-code`');
  await fn();
});

const INGEST = E.DEV_USAGE_IT_INGEST_URL;
const COMPOSE = live ? JSON.parse(E.DEV_USAGE_IT_COMPOSE) : [];

function docker(args) {
  const r = spawnSync('docker', [...COMPOSE, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `docker ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const psql = (sql, role = null) => docker(['exec', '-T', 'dev-usage-postgres', 'psql', '-U', 'dev_usage', '-d', 'dev_usage', '-v', 'ON_ERROR_STOP=1', '-Atc', role ? `SET ROLE ${role}; ${sql}` : sql]);
const psqlFails = (sql, role) => spawnSync('docker', [...COMPOSE, 'exec', '-T', 'dev-usage-postgres', 'psql', '-U', 'dev_usage', '-d', 'dev_usage', '-v', 'ON_ERROR_STOP=1', '-Atc', `SET ROLE ${role}; ${sql}`], { encoding: 'utf8' });

let tokenDir;
async function token() {
  tokenDir ??= mkdtempSync(join(tmpdir(), 'dev-usage-it-'));
  return (await obtainAccessToken({ configDir: tokenDir, tokenUrl: E.DEV_USAGE_IT_TOKEN_URL, clientSecret: E.DEV_USAGE_IT_CLIENT_SECRET })).token;
}
const req = async (path, init = {}, tok) => fetch(`${INGEST}${path}`, {
  ...init,
  headers: { 'content-type': 'application/json', ...(tok === null ? {} : { authorization: `Bearer ${tok ?? await token()}` }), ...(init.headers ?? {}) },
});
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

async function kcAdmin() {
  const t = await fetch(`${E.DEV_USAGE_IT_KC_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: E.DEV_USAGE_IT_KC_ADMIN_PASSWORD }),
  }).then((r) => r.json());
  return { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json' };
}

const session = (id, extra = {}) => ({ session_id: id, project_dir: '-it', capture_status: 'partial', partial_reasons: [], compactions: 0, parser_version: 1, ...extra });
const call = (sid, n, extra = {}) => ({
  session_id: sid, message_id: `msg_${n}`, request_id: `req_${n}`, turn_seq: 1, agent_id: null, ts: '2026-11-20T10:00:00Z', model: 'm',
  input_tokens: n, output_tokens: 2 * n, cache_read_tokens: 3 * n, cache_write_5m_tokens: 4, cache_write_1h_tokens: 1, thinking_tokens: null, skill: null, ...extra,
});
const shipOpts = (sid) => ({ configDir: tokenDir, ingestUrl: INGEST, getToken: token, sessionId: sid, spoolOnFailure: false });

const snapshotCatalog = () => [
  // pg_dump 18 stamps a random \restrict / \unrestrict token on every dump; it is not schema.
  docker(['exec', '-T', 'dev-usage-postgres', 'pg_dump', '-U', 'dev_usage', '-d', 'dev_usage', '--schema-only', '-n', 'usage'])
    .split('\n').filter((l) => !/^\\(un)?restrict /.test(l)).join('\n'),
  psql("SELECT rolname, rolcanlogin, rolinherit FROM pg_roles WHERE rolname IN ('authenticator','usage_writer','usage_reader') ORDER BY 1"),
  psql("SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'usage' ORDER BY 1, 2, 3"),
].join('\n----\n');

// The re-apply goes through a RESTART of the idling init, the same path a host reboot takes.
it('the schema applied a second time changes nothing', async () => {
  const before = snapshotCatalog();
  const id = docker(['ps', '-q', 'dev-usage-schema-init']).trim();
  assert.ok(id, 'dev-usage-schema-init is not running');
  const started = () => spawnSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', id], { encoding: 'utf8' }).stdout.trim();
  const health = () => spawnSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', id], { encoding: 'utf8' }).stdout.trim();
  const firstStart = started();
  docker(['restart', 'dev-usage-schema-init']);
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    ok = started() !== firstStart && health() === 'healthy';
  }
  assert.ok(ok, `schema-init did not come back healthy after a restart (health: ${health()})`);
  assert.match(docker(['logs', '--since', firstStart, 'dev-usage-schema-init']), /applying 040-us1-views\.sql[\s\S]*schema applied/);
  assert.equal(snapshotCatalog(), before);
});

it('a Keycloak token for dev-usage-capture is accepted, and carries role usage_writer and aud dev-usage', async () => {
  const t = await token();
  const c = claims(t);
  assert.equal(c.role, 'usage_writer');
  assert.ok([c.aud].flat().includes('dev-usage'), `aud ${JSON.stringify(c.aud)}`);
  assert.equal(c.azp, 'dev-usage-capture');
  assert.equal((await req('/sessions?limit=1')).status, 200);
});

it('no token, and a token for another realm client, are refused', async () => {
  assert.equal((await req('/sessions?limit=1', {}, null)).status, 401);
  const other = await fetch(E.DEV_USAGE_IT_TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'agent-gateway', client_secret: E.DEV_USAGE_IT_OTHER_CLIENT_SECRET }),
  }).then((r) => r.json());
  assert.ok(other.access_token, 'the other client issued a token');
  assert.equal((await req('/sessions?limit=1', {}, other.access_token)).status, 401);
  assert.equal((await req('/sessions?limit=1', {}, 'not.a.jwt')).status, 401);
});

it('upserts on every natural key are idempotent', async () => {
  await token();
  const sid = randomUUID();
  const batches = {
    sessions: [session(sid)],
    turns: [{ session_id: sid, turn_seq: 1, origin: 'human', started_at: '2026-11-20T10:00:00Z', ended_at: '2026-11-20T10:01:00Z', idle_gap_s: 0, context_tokens_at_start: 9, areas: ['docs'], rereads: 0 }],
    model_calls: [call(sid, 1), call(sid, 2)],
    tool_use: [{ session_id: sid, turn_seq: 1, tool: 'Bash', command_family: 'git', calls: 2, result_bytes: 10, rtk_calls: 1, subagent_type: null }],
    skill_use: [{ session_id: sid, skill: 'speckit-plan', invocations: 1, first_turn: 1 }],
  };
  for (let i = 0; i < 2; i++) assert.deepEqual(await sendBatches(batches, shipOpts(sid)), { ok: true, spooled: false });
  for (const t of ['sessions', 'turns', 'model_calls', 'tool_use', 'skill_use']) {
    assert.equal(psql(`SELECT count(*) FROM usage.${t} WHERE session_id = '${sid}'`).trim(), t === 'model_calls' ? '2' : '1', t);
  }
  // A changed value on the same key updates in place.
  batches.tool_use[0].calls = 3;
  await sendBatches(batches, shipOpts(sid));
  assert.equal(psql(`SELECT calls FROM usage.tool_use WHERE session_id = '${sid}'`).trim(), '3');
});

it('DELETE and TRUNCATE are refused for usage_writer', async () => {
  const sid = randomUUID();
  await sendBatches({ sessions: [session(sid)] }, shipOpts(sid));
  const del = await req(`/sessions?session_id=eq.${sid}`, { method: 'DELETE' });
  assert.ok([401, 403].includes(del.status), `DELETE answered ${del.status}`);
  assert.equal(psql(`SELECT count(*) FROM usage.sessions WHERE session_id = '${sid}'`).trim(), '1');
  const tr = psqlFails('TRUNCATE usage.model_calls', 'usage_writer');
  assert.notEqual(tr.status, 0);
  assert.match(tr.stderr, /permission denied/);
  assert.match(psqlFails('CREATE TABLE usage.x (a int)', 'usage_writer').stderr, /permission denied/);
});

it('an undefined column and an unknown enum value are rejected with 400', async () => {
  const sid = randomUUID();
  const post = (table, rows) => req(`/${table}?on_conflict=session_id`, { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
  assert.equal((await post('sessions', [{ ...session(sid), prompt: 'free text' }])).status, 400);
  assert.equal((await post('sessions', [session(sid, { capture_status: 'bogus' })])).status, 400);
  await sendBatches({ sessions: [session(sid)] }, shipOpts(sid));
  const turn = await req('/turns?on_conflict=session_id,turn_seq', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ session_id: sid, turn_seq: 1, origin: 'bogus' }]) });
  assert.equal(turn.status, 400);
});

it('v_session_totals equals the sums of the posted model calls', async () => {
  const sid = randomUUID();
  const calls = [call(sid, 1), call(sid, 2), call(sid, 3, { agent_id: 'x' })];
  await sendBatches({ sessions: [session(sid)], model_calls: calls }, shipOpts(sid));
  const [row] = await (await req(`/v_session_totals?session_id=eq.${sid}`)).json();
  const sum = (f) => calls.reduce((n, c) => n + f(c), 0);
  assert.equal(Number(row.input_tokens), sum((c) => c.input_tokens));
  assert.equal(Number(row.output_tokens), sum((c) => c.output_tokens));
  assert.equal(Number(row.cache_read_tokens), sum((c) => c.cache_read_tokens));
  assert.equal(Number(row.cache_write_5m_tokens) + Number(row.cache_write_1h_tokens), sum((c) => c.cache_write_5m_tokens + c.cache_write_1h_tokens));
  assert.equal(Number(row.subagent_tokens), 3 + 6 + 9 + 5);
  assert.equal(Number(row.model_calls), 3);
});

it('5 parallel hook processes over the fixtures leave the same rows and totals as one serial run (SC-003)', async () => {
  const NOW = String(Date.parse('2026-11-21T12:00:00.000Z'));
  const store = { ingestUrl: INGEST, tokenUrl: E.DEV_USAGE_IT_TOKEN_URL };
  const withSecret = (cfgDir, extra) => ({ ...envFor(cfgDir, store, extra), MCM_USAGE_CLIENT_SECRET: E.DEV_USAGE_IT_CLIENT_SECRET });
  const ids = Object.values(SESSION).map((s) => `'${s}'`).join(',');
  const counts = () => ['sessions', 'model_calls', 'turns', 'tool_use', 'skill_use']
    .map((t) => `${t}=${psql(`SELECT count(*) FROM usage.${t} WHERE session_id IN (${ids})`).trim()}`).join(' ');

  const par = tempConfigDir();
  try {
    const env = withSecret(par.dir, { CC_USAGE_NOW: NOW, CC_USAGE_SHIP_INTERVAL_S: '0' });
    const events = [['SessionStart', 'C'], ['Stop', 'A'], ['SessionStart', 'A'], ['Stop', 'B'], ['Stop', 'A']];
    const runs = await Promise.all(events.map(([e, k]) => runCli(['hook'], { env, stdin: hookEvent(e, k, par.dir) })));
    for (const r of runs) assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
    await runCli(['hook'], { env: withSecret(par.dir, { CC_USAGE_NOW: String(Number(NOW) + 16 * 60_000) }), stdin: hookEvent('SessionStart', 'C', par.dir) });
  } finally {
    par.cleanup();
  }
  const parallel = counts();

  const ser = tempConfigDir();
  try {
    await runCli(['hook'], { env: withSecret(ser.dir, { CC_USAGE_NOW: NOW }), stdin: hookEvent('SessionStart', 'C', ser.dir) });
  } finally {
    ser.cleanup();
  }
  assert.equal(counts(), parallel, 'parallel row count != serial row count');
  assert.match(parallel, /sessions=4 model_calls=15 /);

  const expected = sessionTotals(FIXTURES);
  for (const [sid, t] of Object.entries(expected)) {
    const [row] = await (await req(`/v_session_totals?session_id=eq.${sid}`)).json();
    assert.deepEqual({
      input: Number(row.input_tokens), output: Number(row.output_tokens),
      cache_write: Number(row.cache_write_5m_tokens) + Number(row.cache_write_1h_tokens), cache_read: Number(row.cache_read_tokens),
    }, t, `store totals for ${sid.slice(0, 8)}`);
  }
});

// Last: it waits out a short-lived token (PostgREST allows ~30 s of clock skew on `exp`).
it('an expired token is refused', async () => {
  const h = await kcAdmin();
  const kc = E.DEV_USAGE_IT_KC_URL;
  const [client] = await fetch(`${kc}/admin/realms/grumpyrobot/clients?clientId=dev-usage-capture`, { headers: h }).then((r) => r.json());
  const set = (lifespan) => fetch(`${kc}/admin/realms/grumpyrobot/clients/${client.id}`, {
    method: 'PUT', headers: h, body: JSON.stringify({ ...client, attributes: { ...client.attributes, 'access.token.lifespan': String(lifespan) } }),
  });
  assert.equal((await set(1)).status, 204);
  let short;
  try {
    short = await fetch(E.DEV_USAGE_IT_TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'dev-usage-capture', client_secret: E.DEV_USAGE_IT_CLIENT_SECRET }),
    }).then((r) => r.json());
  } finally {
    await set(3600);
  }
  assert.ok(claims(short.access_token).exp - claims(short.access_token).iat <= 1);
  await new Promise((r) => setTimeout(r, 35_000));
  assert.equal((await req('/sessions?limit=1', {}, short.access_token)).status, 401);
});

test.after(() => { if (tokenDir) rmSync(tokenDir, { recursive: true, force: true }); });

// --- US2 read paths (T038): the queries `sessions`, `trend`, `compare`, `now` and `tag` send -------
it('US2: filtered, ordered, limited reads of v_session_totals and v_turn_totals return the seeded rows', async () => {
  await token();
  const branch = `it-us2-${randomUUID().slice(0, 8)}`;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, sid] of ids.entries()) {
    const day = `2026-11-1${i + 1}`;
    const r = await sendBatches({
      sessions: [session(sid, { starting_branch: branch, started_at: `${day}T09:00:00Z` })],
      turns: [1, 2].map((turn_seq) => ({ session_id: sid, turn_seq, origin: 'human', started_at: `${day}T09:0${turn_seq}:00Z`, ended_at: `${day}T09:0${turn_seq}:30Z`, idle_gap_s: 0, context_tokens_at_start: 5, areas: turn_seq === 1 ? ['docs'] : (i === 0 ? ['scripts'] : []), rereads: 0 })),
      model_calls: [call(sid, 10 + i, { turn_seq: 1 }), call(sid, 20 + i, { turn_seq: 2, agent_id: 'sub' })],
    }, shipOpts(sid));
    assert.deepEqual(r, { ok: true, spooled: false });
  }
  const json = async (path) => { const r = await req(path); assert.equal(r.status, 200, `${path} → ${r.status}`); return r.json(); };

  const two = await json(`/v_session_totals?starting_branch=eq.${branch}&order=started_at.desc&limit=2`);
  assert.deepEqual(two.map((s) => s.session_id), [ids[2], ids[1]], 'ordered newest first, limited to 2');
  assert.equal(two[0].turns, 2);
  assert.equal(two[0].input_tokens, 12 + 22);
  assert.equal(two[0].subagent_tokens > 0, true);

  const scripts = await json(`/v_session_totals?starting_branch=eq.${branch}&areas=cs.%7Bscripts%7D`);
  assert.deepEqual(scripts.map((s) => s.session_id), [ids[0]], 'areas: the union of the turns\' areas, filterable');
  const since = await json(`/v_session_totals?starting_branch=eq.${branch}&started_at=gte.2026-11-12T00:00:00Z`);
  assert.equal(since.length, 2);

  const turns = await json(`/v_turn_totals?session_id=eq.${ids[0]}&order=turn_seq.asc`);
  assert.deepEqual(turns.map((t) => [t.turn_seq, t.areas, t.input_tokens]), [[1, ['docs'], 10], [2, ['scripts'], 20]]);
});

it('US2: PATCH sessions sets manual_tag; a column sessions does not have is refused', async () => {
  await token();
  const sid = randomUUID();
  await sendBatches({ sessions: [session(sid)] }, shipOpts(sid));
  const ok = await req(`/sessions?session_id=eq.${sid}`, { method: 'PATCH', body: JSON.stringify({ manual_tag: 'refactor-x' }) });
  assert.equal(ok.status, 204);
  assert.equal(psql(`SELECT manual_tag FROM usage.sessions WHERE session_id = '${sid}'`).trim(), 'refactor-x');
  const bad = await req(`/sessions?session_id=eq.${sid}`, { method: 'PATCH', body: JSON.stringify({ input_tokens: 1 }) });
  assert.equal(bad.status, 400, 'sessions has no token columns to change');
});

// --- US3 (T047): features, attribution views, conservation, weights --------------------------------
const TOKEN_COLS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens'];
const getJson = async (path) => { const r = await req(path); assert.equal(r.status, 200, `${path} → ${r.status} ${await r.clone().text()}`); return r.json(); };
const turn = (sid, seq, extra = {}) => ({ session_id: sid, turn_seq: seq, origin: 'human', started_at: '2026-11-18T10:00:00Z', ended_at: '2026-11-18T10:01:00Z', idle_gap_s: 0, context_tokens_at_start: 1, areas: [], rereads: 0, activity: 'implement', activity_rule: 'implement-edit', feature_id: null, attribution_rule: 'main', ...extra });
const feat = (id, extra = {}) => ({ feature_id: id, branch: id.split('@')[0], first_seen_at: '2026-11-18T09:00:00Z', kind: 'no-spec', pr_state: 'none', ...extra });

it('US3: feature totals are sums of attributed turns; no-feature holds main turns; features + no-feature = sessions', async () => {
  await token();
  const p = `it-us3-${randomUUID().slice(0, 6)}`;
  const F1 = `${p}-spec@2026-11-18`;
  const F2 = `${p}-nospec@2026-11-18`;
  const F3old = `${p}-reused@2026-11-01`;
  const F3new = `${p}-reused@2026-11-18`;
  const features = [
    feat(F1, { kind: 'spec', spec_dir: 'specs/999-it', spec_number: 999, tasks_total: 10, tasks_done: 4, pr_state: 'merged', pr_number: 1, merged_at: '2026-11-19T00:00:00Z', first_red_at: '2026-11-18T10:30:00Z' }),
    feat(F2),
    feat(F3old, { pr_state: 'merged', pr_number: 2, merged_at: '2026-11-02T00:00:00Z', first_seen_at: '2026-11-01T09:00:00Z' }),
    feat(F3new),
  ];
  const noFeatureBefore = (await getJson('/v_no_feature_totals'))[0] ?? {};
  // S1–S3 on F1; S4 split F1/F2; S5 main only; S6 on the reused name's new feature.
  const S = Array.from({ length: 6 }, () => randomUUID());
  let n = 1000;
  const plan = [
    [S[0], [[1, F1, 'worktree']]], [S[1], [[1, F1, 'worktree']]], [S[2], [[1, F1, 'inherited']]],
    [S[3], [[1, F1, 'worktree'], [2, F2, 'worktree']]], [S[4], [[1, null, 'main'], [2, null, 'main']]], [S[5], [[1, F3new, 'worktree']]],
  ];
  const expectFeature = {};
  let mainTokens = 0;
  for (const [sid, turns] of plan) {
    const calls = turns.map(([seq, fid]) => { n += 1; const c = call(sid, n, { turn_seq: seq, message_id: `msg_us3_${n}` }); const t = TOKEN_COLS.reduce((a, k) => a + c[k], 0); if (fid) expectFeature[fid] = (expectFeature[fid] ?? 0) + c.input_tokens; else mainTokens += t; return c; });
    const r = await sendBatches({
      sessions: [session(sid)],
      features,
      turns: turns.map(([seq, fid, rule]) => turn(sid, seq, { feature_id: fid, attribution_rule: rule })),
      model_calls: calls,
    }, shipOpts(sid));
    assert.deepEqual(r, { ok: true, spooled: false }, sid);
  }
  const ft = await getJson(`/v_feature_totals?branch=like.${p}*&order=feature_id`);
  const byId = Object.fromEntries(ft.map((f) => [f.feature_id, f]));
  assert.equal(byId[F1].input_tokens, expectFeature[F1]);
  assert.equal(byId[F1].sessions, 4, 'S1–S3 and the split S4');
  assert.equal(byId[F2].input_tokens, expectFeature[F2]);
  assert.equal(byId[F3new].input_tokens, expectFeature[F3new]);
  assert.equal(byId[F3old].input_tokens, 0, 'the merged feature of a reused name keeps its own (zero) totals');
  assert.equal(byId[F1].tasks_total, 10);

  const nf = (await getJson('/v_no_feature_totals'))[0];
  const delta = TOKEN_COLS.reduce((a, k) => a + Number(nf[k]) - Number(noFeatureBefore[k] ?? 0), 0);
  assert.equal(delta, mainTokens, 'the main-branch turns land in no-feature');

  // Conservation (SC-010) over the whole store, every token type.
  const all = await getJson('/v_feature_totals');
  const sessions = await getJson('/v_session_totals');
  for (const k of TOKEN_COLS) {
    const f = all.reduce((a, r) => a + Number(r[k]), 0) + Number(nf[k]);
    const s = sessions.reduce((a, r) => a + Number(r[k]), 0);
    assert.equal(f, s, `features + no-feature = sessions for ${k}`);
  }
});

it('US3: v_feature_efficiency gives per-task figures only where tasks_total is set, grouped by kind', async () => {
  const eff = await getJson('/v_feature_efficiency');
  const kinds = Object.fromEntries(eff.map((r) => [r.kind, r]));
  assert.ok(kinds.spec && kinds['no-spec'], JSON.stringify(eff));
  assert.equal(kinds['no-spec'].weighted_per_task_done, null);
  assert.ok(Number(kinds.spec.weighted_per_task_done) > 0);
  assert.ok('weighted_per_merged_pr' in kinds.spec && 'rework_share' in kinds.spec);
});

it('US3: v_weekly_trend has feature and spec dimensions; v_session_activity_mix marks the dominant activity', async () => {
  const rows = await getJson('/v_weekly_trend?spec_number=eq.999');
  assert.ok(rows.length > 0 && rows.every((r) => r.feature_id && r.week && r.activity), JSON.stringify(rows[0]));
  // A multi-area turn is split across its areas, so the trend sums back to the turns exactly.
  const trend = await getJson('/v_weekly_trend');
  const turns = await getJson('/v_turn_totals?started_at=not.is.null');
  const sum = (rs, k) => rs.reduce((a, r) => a + Number(r[k]), 0);
  for (const k of ['input_tokens', 'weighted_tokens']) assert.ok(Math.abs(sum(trend, k) - sum(turns, k)) < 1e-6, `${k}: trend ${sum(trend, k)} vs turns ${sum(turns, k)}`);
  assert.ok(Math.abs(sum(trend, 'turns') - turns.length) < 1e-6);
  const mix = await getJson('/v_session_activity_mix?limit=5');
  assert.ok(mix.length > 0 && mix.every((m) => 'dominant' in m && 'share' in m));
});

it('US3: token_weights upserts by as_of and the latest changes v_call_weighted', async () => {
  const sid = randomUUID();
  await sendBatches({ sessions: [session(sid)], model_calls: [call(sid, 7, { message_id: 'msg_w', input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0 })] }, shipOpts(sid));
  const put = (output) => req('/token_weights?on_conflict=as_of', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ as_of: '2100-01-01', input: 1, output, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2, source: 'it' }]) });
  assert.equal((await put(5)).status, 201);
  const w1 = (await getJson(`/v_call_weighted?session_id=eq.${sid}`))[0].weighted_tokens;
  assert.equal(Number(w1), 10 + 5);
  assert.ok([200, 201].includes((await put(9)).status));
  const w2 = (await getJson(`/v_call_weighted?session_id=eq.${sid}`))[0].weighted_tokens;
  assert.equal(Number(w2), 10 + 9);
});

it('US3: every Grafana panel query runs as usage_reader against the real views', () => {
  const dash = JSON.parse(readFileSync(new URL('../../observability/grafana/dashboards/claude-code-usage.json', import.meta.url), 'utf8'));
  for (const p of dash.panels) {
    for (const t of p.targets) {
      const sql = t.rawSql.replace(/\$__timeFilter\([^)]*\)/g, 'true');
      const r = psqlFails(sql, 'usage_reader');
      assert.equal(r.status, 0, `${p.title}: ${r.stderr}`);
    }
  }
});
