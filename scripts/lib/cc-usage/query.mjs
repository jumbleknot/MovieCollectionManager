// Feature 105 US2 — the interactive commands (contracts/cli.md "Interactive commands"): `now`,
// `sessions`, `trend`, `compare`, `sync`, `tag`. Reads go to the store's views over PostgREST with the
// same Keycloak token the hooks use; `now` answers from LOCAL state first, so it works offline (FR-020).
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, shipSession } from './capture.mjs';
import { readSessionState, spoolDepth } from './local-state.mjs';
import { obtainAccessToken } from './obtain-access-token.mjs';
import { emptySummary, foldSummary, parseSessionFiles, TOKEN_TYPES } from './session-summary.mjs';
import { configuredHosts, renderTable } from './render-table.mjs';
import { timedFetch } from './timed-fetch.mjs';
import { listSessions, sessionPaths } from './transcript-files.mjs';

export class Unreachable extends Error {}

const rowTotal = (r) => TOKEN_TYPES.reduce((n, t) => n + Number(r[`${t}_tokens`] ?? 0), 0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const readBuf = (p) => { try { return p && existsSync(p) ? readFileSync(p) : null; } catch { return null; } };

function sessionFiles(configDir, sessionId) {
  const s = listSessions(configDir).find((x) => x.sessionId === sessionId);
  if (!s) return null;
  const { mainPath, subagents } = sessionPaths(configDir, s.projectDir, sessionId);
  return { projectDir: s.projectDir, mainBuf: readBuf(mainPath), subagents: subagents.map((a) => ({ agentId: a.agentId, buf: readBuf(a.transcriptPath) })) };
}

/** Summary of everything on disk for this session: stored summary + the unshipped tail, or a full parse. */
export function localSummary(configDir, sessionId) {
  const f = sessionFiles(configDir, sessionId);
  if (!f) return null;
  const st = readSessionState(configDir, sessionId);
  const states = st?.files ?? {};
  const fresh = st?.summary && Object.entries(states).every(([k, v]) => (st.summary.offsets?.[k] ?? -1) === v.offset);
  if (fresh) return foldSummary(st.summary, parseSessionFiles({ sessionId, ...f, states }));
  return foldSummary(emptySummary(), parseSessionFiles({ sessionId, ...f }));
}

// --- the store --------------------------------------------------------------------------------------

function store(cfg) {
  const get = async (path) => {
    if (!cfg.configured) throw new Unreachable();
    let res;
    try {
      const { token } = await obtainAccessToken({ configDir: cfg.configDir, tokenUrl: cfg.tokenUrl, clientSecret: cfg.clientSecret, fetch: cfg.fetch, now: cfg.now() });
      res = await timedFetch(cfg.fetch, `${cfg.ingestUrl.replace(/\/+$/, '')}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    } catch {
      throw new Unreachable();
    }
    if (!res.ok) throw new Unreachable();
    try { return JSON.parse(res.body); } catch { throw new Unreachable(); }
  };
  const patch = async (path, body) => {
    if (!cfg.configured) throw new Unreachable();
    let res;
    try {
      const { token } = await obtainAccessToken({ configDir: cfg.configDir, tokenUrl: cfg.tokenUrl, clientSecret: cfg.clientSecret, fetch: cfg.fetch, now: cfg.now() });
      res = await timedFetch(cfg.fetch, `${cfg.ingestUrl.replace(/\/+$/, '')}${path}`, {
        method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify(body),
      });
    } catch {
      throw new Unreachable();
    }
    if (!res.ok) throw new Unreachable();
  };
  return { get, patch };
}

export const unreachableLine = (cfg) => `usage history: store unreachable (spooled ${spoolDepth(cfg.configDir).files})`;

/** `--since 7d|12h|8w` → ISO instant. */
export function sinceIso(since, now) {
  const m = String(since).match(/^(\d+)([hdw])$/);
  if (!m) throw new RangeError(`--since: expected <n>h, <n>d or <n>w, got ${since}`);
  const ms = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2]] * Number(m[1]);
  return new Date(now - ms).toISOString();
}

const q = (params) => params.filter(Boolean).join('&');
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

// --- commands ---------------------------------------------------------------------------------------

export async function now(cfg, { session, json }) {
  const s = localSummary(cfg.configDir, session);
  if (!s) return { code: 0, out: `now: no transcript for session ${session.slice(0, 8)} on this volume` };
  const total = TOKEN_TYPES.reduce((n, t) => n + s.tokens[t], 0);
  const byTool = new Map();
  for (const t of Object.values(s.tools)) {
    const k = `${t.tool}\u0000${t.family}`;
    const v = byTool.get(k) ?? { tool: t.tool, family: t.family || null, calls: 0, bytes: 0 };
    v.calls += t.calls;
    v.bytes += t.bytes;
    byTool.set(k, v);
  }
  const top = [...byTool.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  let recent = null;
  try {
    const rows = await store(cfg).get(`/v_session_totals?${q([`session_id=neq.${session}`, 'order=started_at.desc', 'limit=20'])}`);
    const totals = rows.map(rowTotal).filter((n) => n > 0);
    if (totals.length) recent = { tokens: median(totals), n: totals.length };
  } catch (e) {
    if (!(e instanceof Unreachable)) throw e;
  }
  const result = {
    session_id: session,
    tokens: { ...s.tokens, total },
    model_calls: s.calls,
    context_now: s.contextNow,
    subagent_share: total ? Math.round((s.sub / total) * 1000) / 1000 : 0,
    top_tools: top,
    recent_median: recent,
  };
  if (json) return { code: 0, out: JSON.stringify(result, null, 2) };
  const hosts = configuredHosts();
  const lines = [
    `session ${session.slice(0, 8)}  model calls ${s.calls}  context now ${s.contextNow.toLocaleString('en-US')} tokens  subagent share ${Math.round(result.subagent_share * 100)}%`,
    renderTable([{ ...s.tokens, total }], [...TOKEN_TYPES.map((t) => ({ key: t, label: t.replace(/_/g, ' '), align: 'right' })), { key: 'total', align: 'right' }], { hosts }),
    'top tool outputs',
    renderTable(top, [{ key: 'tool' }, { key: 'family' }, { key: 'calls', align: 'right' }, { key: 'bytes', align: 'right' }], { hosts }),
    recent ? `recent sessions: median ${recent.tokens.toLocaleString('en-US')} tokens (n=${recent.n}); this session ${total.toLocaleString('en-US')}` : 'recent sessions: store unreachable',
  ];
  return { code: 0, out: lines.join('\n') };
}

const SESSION_COLS = [
  { key: 'started', label: 'started' },
  { key: 'session', label: 'session' },
  { key: 'branch' },
  { key: 'turns', align: 'right' },
  { key: 'tokens', align: 'right' },
  { key: 'subagent', label: 'sub %', align: 'right' },
  { key: 'tag' },
];
const sessionRow = (r) => {
  const tokens = rowTotal(r);
  return {
    started: r.started_at ? String(r.started_at).slice(0, 16).replace('T', ' ') : null,
    session: String(r.session_id).slice(0, 8),
    session_id: r.session_id,
    branch: r.starting_branch ?? null,
    turns: Number(r.turns ?? 0),
    tokens,
    subagent: tokens ? Math.round((Number(r.subagent_tokens ?? 0) / tokens) * 100) : 0,
    tag: r.manual_tag ?? null,
  };
};

export async function sessions(cfg, { since, branch, area, json }) {
  const params = [
    since && `started_at=gte.${sinceIso(since, cfg.now())}`,
    branch && `starting_branch=eq.${encodeURIComponent(branch)}`,
    area && `areas=cs.${encodeURIComponent(`{${area}}`)}`,
    'order=started_at.desc',
    'limit=500',
  ];
  const rows = (await store(cfg).get(`/v_session_totals?${q(params)}`)).map(sessionRow);
  return { code: 0, out: renderTable(rows, SESSION_COLS, { json, hosts: configuredHosts() }) };
}

/** Monday of the ISO week containing `iso`, as YYYY-MM-DD (UTC). */
export function weekOf(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export async function trend(cfg, { by, since = '8w', json }) {
  const from = `started_at=gte.${sinceIso(since, cfg.now())}`;
  const hosts = configuredHosts();
  if (by === 'week') {
    const rows = await store(cfg).get(`/v_session_totals?${q([from, 'order=started_at.asc'])}`);
    const buckets = new Map();
    for (const r of rows) {
      if (!r.started_at) continue;
      const w = weekOf(r.started_at);
      const b = buckets.get(w) ?? { week: w, sessions: 0, tokens: 0 };
      b.sessions += 1;
      b.tokens += rowTotal(r);
      buckets.set(w, b);
    }
    const out = [...buckets.values()].sort((a, b) => a.week.localeCompare(b.week));
    return { code: 0, out: renderTable(out, [{ key: 'week' }, { key: 'sessions', align: 'right' }, { key: 'tokens', align: 'right' }], { json, hosts }) };
  }
  if (by === 'area') {
    // A turn that touched several areas counts toward each of them.
    const rows = await store(cfg).get(`/v_turn_totals?${q([from, 'select=areas,input_tokens,output_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens'])}`);
    const buckets = new Map();
    for (const r of rows) {
      for (const a of r.areas?.length ? r.areas : ['(none)']) {
        const b = buckets.get(a) ?? { area: a, turns: 0, tokens: 0 };
        b.turns += 1;
        b.tokens += rowTotal(r);
        buckets.set(a, b);
      }
    }
    const out = [...buckets.values()].sort((a, b) => b.tokens - a.tokens);
    return { code: 0, out: renderTable(out, [{ key: 'area' }, { key: 'turns', align: 'right' }, { key: 'tokens', align: 'right' }], { json, hosts }) };
  }
  return null; // US3 dimensions are dispatched by the caller
}

const RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

/** Resolve one side of `compare` to session rows. Returns null for forms this story does not handle. */
async function compareSide(st, spec) {
  if (UUID.test(spec)) return { label: spec.slice(0, 8), rows: await st.get(`/v_session_totals?session_id=eq.${spec}`) };
  const m = spec.match(RANGE);
  if (m) {
    const end = new Date(Date.parse(`${m[2]}T00:00:00Z`) + 86_400_000).toISOString();
    return { label: spec, rows: await st.get(`/v_session_totals?${q([`started_at=gte.${m[1]}T00:00:00Z`, `started_at=lt.${end}`])}`) };
  }
  return null;
}

export function compareRows(a, b) {
  const agg = (rows) => {
    const sum = (k) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
    const total = rows.reduce((n, r) => n + rowTotal(r), 0);
    return { sessions: rows.length, turns: sum('turns'), total, ...Object.fromEntries(TOKEN_TYPES.map((t) => [t, sum(`${t}_tokens`)])), sub: sum('subagent_tokens') };
  };
  const A = agg(a);
  const B = agg(b);
  const row = (metric, k) => ({ metric, a: A[k], b: B[k] });
  return [
    row('sessions', 'sessions'), row('turns', 'turns'), row('total tokens', 'total'),
    ...TOKEN_TYPES.map((t) => row(t.replace(/_/g, ' '), t)),
    { metric: 'subagent share', a: A.total ? Math.round((A.sub / A.total) * 1000) / 1000 : 0, b: B.total ? Math.round((B.sub / B.total) * 1000) / 1000 : 0 },
  ];
}

export async function compare(cfg, { a, b, json }, resolveExtra = null) {
  const st = store(cfg);
  const side = async (spec) => (await compareSide(st, spec)) ?? (resolveExtra ? await resolveExtra(st, spec) : null);
  const A = await side(a);
  const B = await side(b);
  if (!A || !B) return { code: 2, err: `compare: cannot read ${!A ? a : b} (session id or YYYY-MM-DD..YYYY-MM-DD)` };
  const rows = compareRows(A.rows, B.rows);
  return { code: 0, out: renderTable(rows, [{ key: 'metric' }, { key: 'a', label: A.label, align: 'right' }, { key: 'b', label: B.label, align: 'right' }], { json, hosts: configuredHosts(), limit: 50 }) };
}

export async function sync(cfg, { session }) {
  if (!cfg.configured) return { code: 0, out: `sync: not configured (missing ${cfg.missing.join(', ')})` };
  const s = listSessions(cfg.configDir).find((x) => x.sessionId === session);
  if (!s) return { code: 0, out: `sync: no transcript for session ${session.slice(0, 8)} on this volume` };
  const r = await shipSession(cfg, { projectDir: s.projectDir, sessionId: session });
  return { code: 0, out: `sync ${session.slice(0, 8)}: ${r}` };
}

const TAG = /^[A-Za-z0-9._-]{1,40}$/;

export async function tag(cfg, { session, label }) {
  if (!TAG.test(label ?? '')) return { code: 2, err: 'tag: the label is 1-40 characters of letters, digits, ".", "_" or "-"' };
  await store(cfg).patch(`/sessions?session_id=eq.${session}`, { manual_tag: label });
  return { code: 0, out: `tagged ${session.slice(0, 8)}: ${label}` };
}

export { loadConfig };
