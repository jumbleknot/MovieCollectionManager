// Feature 105 — the store contract, against a REAL Postgres + PostgREST + Keycloak (no mocks;
// constitution "Test Type Integrity"). Run through `pnpm nx dev-usage-integration
// infrastructure-as-code`, which brings the stack up and passes its URLs and secrets in DEV_USAGE_IT_*.
// Without them every test SKIPS — unless MCM_REQUIRE_LIVE_STACK=1, which makes that a failure.
// (US1-AC1, US1-AC5; FR-008, FR-013, FR-014, SC-003; contracts/store-http.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
