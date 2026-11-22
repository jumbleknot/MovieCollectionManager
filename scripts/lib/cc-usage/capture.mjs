// Capture orchestration for feature 105: the `hook` command, the catch-up sweep, spool flushing and
// `doctor` (contracts/cli.md; data-model.md "Local state" and sessions.capture_status).
//
// Ordering rule that keeps concurrent processes correct (FR-009): everything that ships records for
// a session — a Stop, a SessionEnd, a sweep, or a spool replay — runs under that session's lock, and
// replays the session's spool (oldest first) BEFORE shipping anything newer. Turn and tool rows are
// cumulative upserts, so an older batch landing after a newer one would regress them; the lock and
// the order make that impossible. Offsets advance only once a batch is sent or durably spooled.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  acquireLock, backoffActive, BACKOFF_MS, log, paths, readJson, readSessionState, readSpoolDrops, releaseLock,
  spoolClaim, spoolComplete, spoolDepth, spoolRelease, writeAtomic, writeCwdMarker, writeSessionState,
} from './local-state.mjs';
import { obtainAccessToken, tokenState } from './obtain-access-token.mjs';
import { captureStatus, initialState, parseTranscript, summarizeSession } from './parse-transcript.mjs';
import { emptySummary, foldSummary, parseSessionFiles } from './session-summary.mjs';
import { attribute, collectOutcomes, pushWeights, reconcileOpen } from './feature-context.mjs';
import { sendBatches, shipRecords } from './ship-records.mjs';
import { listSessions, sessionPaths } from './transcript-files.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const STALE_MS = 24 * 60 * 60 * 1000;
const REQUIRED = ['MCM_USAGE_INGEST_URL', 'MCM_USAGE_TOKEN_URL', 'MCM_USAGE_CLIENT_SECRET'];

/** Everything a run needs, from the environment. CC_USAGE_NOW / CC_USAGE_TEST_* are test-only. */
export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  const rawNow = env.CC_USAGE_NOW;
  const fixedNow = rawNow ? (/^\d+$/.test(rawNow) ? Number(rawNow) : Date.parse(rawNow)) : null;
  const interval = Number(env.CC_USAGE_SHIP_INTERVAL_S ?? 900);
  const trace = env.CC_USAGE_TEST_TRACE || null;
  const traceEvent = (what) => {
    if (trace) try { appendFileSync(trace, `${what}\n`); } catch { /* test aid only */ }
  };
  const realFetch = globalThis.fetch;
  return {
    configDir: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    ingestUrl: env.MCM_USAGE_INGEST_URL,
    tokenUrl: env.MCM_USAGE_TOKEN_URL,
    clientSecret: env.MCM_USAGE_CLIENT_SECRET,
    configured: missing.length === 0,
    missing,
    intervalMs: (Number.isFinite(interval) ? interval : 900) * 1000,
    now: () => fixedNow ?? Date.now(),
    sweepMaxSessions: env.CC_USAGE_TEST_SWEEP_MAX_SESSIONS ? Number(env.CC_USAGE_TEST_SWEEP_MAX_SESSIONS) : Infinity,
    testWorktrees: env.CC_USAGE_TEST_WORKTREES || null, // test-only: a worktrees.json in place of `git rev-parse`
    repoDir: env.CLAUDE_PROJECT_DIR || process.cwd(), // a checkout for git and specs/ when a feature's worktree is gone
    traceEvent,
    fetch: (url, init) => {
      traceEvent(`fetch ${new URL(url).pathname}`);
      return realFetch(url, init);
    },
  };
}

function shipOpts(cfg, sessionId, range) {
  const now = cfg.now();
  return {
    configDir: cfg.configDir,
    ingestUrl: cfg.ingestUrl,
    fetch: cfg.fetch,
    getToken: async () => (await obtainAccessToken({
      configDir: cfg.configDir, tokenUrl: cfg.tokenUrl, clientSecret: cfg.clientSecret, fetch: cfg.fetch, now,
    })).token,
    sessionId,
    range,
    now,
  };
}

/** Replay one session's spool, oldest first. Caller holds the session lock. */
async function flushSessionSpool(cfg, sessionId) {
  const claims = spoolClaim(cfg.configDir, { sessionId, now: cfg.now() });
  for (let i = 0; i < claims.length; i++) {
    const { claimedPath, entry } = claims[i];
    const r = await sendBatches(entry.batches ?? {}, { ...shipOpts(cfg, sessionId, entry.range), spoolOnFailure: false });
    if (!r.ok) {
      for (const c of claims.slice(i)) spoolRelease(c.claimedPath);
      return false;
    }
    spoolComplete(claimedPath);
    writeAtomic(paths(cfg.configDir).ship, JSON.stringify({ lastOkAt: cfg.now() }));
  }
  return true;
}

/** Flush every session's spool (SessionStart). */
async function flushAllSpool(cfg) {
  const dir = paths(cfg.configDir).spool;
  if (!existsSync(dir)) return;
  const ids = new Set();
  for (const n of readdirSync(dir)) {
    const m = n.match(/^\d+-([0-9a-f-]{36})-/i);
    if (m) ids.add(m[1]);
  }
  for (const id of ids) {
    if (backoffActive(cfg.configDir, { now: cfg.now() })) return;
    if (!acquireLock(cfg.configDir, `session-${id}`, { now: cfg.now(), ttlMs: 120_000 })) continue;
    try {
      await flushSessionSpool(cfg, id);
    } finally {
      releaseLock(cfg.configDir, `session-${id}`);
    }
  }
}

const readOrNull = (p) => {
  try {
    return p && existsSync(p) ? readFileSync(p) : null;
  } catch {
    return null;
  }
};

/**
 * Ship one session's new bytes. Returns 'shipped' | 'spooled' | 'nothing' | 'locked' | 'backoff' | 'absent'.
 * @param {{ended?: boolean, endReason?: string, sweep?: boolean}} how
 */
export async function shipSession(cfg, { projectDir, sessionId }, how = {}) {
  const now = cfg.now();
  const dir = cfg.configDir;
  const { mainPath, subagents } = sessionPaths(dir, projectDir, sessionId);
  if (!existsSync(mainPath) && subagents.length === 0) return 'absent';
  if (!acquireLock(dir, `session-${sessionId}`, { now, ttlMs: 120_000 })) return 'locked';
  try {
    const prev = readSessionState(dir, sessionId) ?? { files: {} };
    const st = { ...prev, files: { ...(prev.files ?? {}) }, projectDir };
    if (how.ended && !st.endedAt) {
      st.endedAt = new Date(now).toISOString();
      st.endReason = typeof how.endReason === 'string' && /^[a-z_-]{1,40}$/.test(how.endReason) ? how.endReason : 'other';
      st.staleInferred = false;
    }
    const saveEndOnly = () => writeSessionState(dir, sessionId, { files: {}, endedAt: st.endedAt, endReason: st.endReason, projectDir });
    if (backoffActive(dir, { now })) {
      saveEndOnly();
      return 'backoff';
    }
    if (!(await flushSessionSpool(cfg, sessionId))) {
      saveEndOnly();
      return 'backoff';
    }

    cfg.traceEvent(`parse ${sessionId}`);
    const opts = { sessionId, projectDir };
    const records = { modelCalls: [], turns: [], toolUse: [], skillUse: [] };
    // Model calls are deduped SESSION-wide (T077): a forked subagent's transcript repeats its parent's
    // assistant lines with the same message id, and the parser dedups only within one file. Every id
    // any of this session's transcripts already emitted is claimed; the first (main) keeps the call.
    const claimed = new Set(Object.values(st.files).flatMap((f) => f?.seen ?? []));
    const unclaimed = (calls) => calls.filter((c) => !claimed.has(c.message_id) && claimed.add(c.message_id));
    const mainBuf = readOrNull(mainPath);
    let mainSession = null;
    let mainSignals = {};
    const range = { file: 'main', from: st.files.main?.offset ?? 0, to: null };
    if (mainBuf) {
      const r = parseTranscript(mainBuf, st.files.main ?? initialState(), opts);
      st.files.main = r.state;
      mainSession = r.records.session;
      mainSignals = r.signals ?? {};
      range.to = r.state.offset;
      records.modelCalls.push(...unclaimed(r.records.modelCalls));
      records.turns.push(...r.records.turns);
      records.toolUse.push(...r.records.toolUse);
      records.skillUse.push(...r.records.skillUse);
    }
    const subBufs = [];
    const reasons = [...(st.files.main?.reasons ?? [])];
    const add = (r) => { if (!reasons.includes(r)) reasons.push(r); };
    for (const s of subagents) {
      const tbuf = readOrNull(s.transcriptPath);
      subBufs.push({ agentId: s.agentId, buf: tbuf });
      if (!tbuf) {
        add('subagent-transcript-missing');
        continue;
      }
      const meta = s.metaPath ? readJson(s.metaPath, null) : null;
      const parentTurn = st.files.main?.agentSpawns?.[meta?.toolUseId] ?? null;
      const key = `agent-${s.agentId}`;
      const r = parseTranscript(tbuf, st.files[key] ?? initialState(), { ...opts, agentId: s.agentId, parentTurn });
      st.files[key] = r.state;
      records.modelCalls.push(...unclaimed(r.records.modelCalls));
      for (const why of r.state.reasons) add(why);
    }

    const main = st.files.main;
    const lastTs = main?.turn?.ended_at ?? main?.lastTurnEndedAt ?? null;
    if (how.sweep && mainBuf && !st.endedAt && lastTs && now - Date.parse(lastTs) > STALE_MS) {
      st.endedAt = lastTs;
      st.endReason = 'inferred-stale';
      st.staleInferred = true;
    }
    if (st.staleInferred) add('no-session-end');

    const base = mainSession ?? summarizeSession({ sessionId, projectDir, main: null }).session;
    const session = {
      ...base,
      ended_at: st.endedAt ?? null,
      end_reason: st.endReason ?? null,
      capture_status: captureStatus({ hasMain: Boolean(mainBuf), reasons, ended: Boolean(st.endedAt) }),
      partial_reasons: reasons,
    };
    // The incremental summary `now` reads (US2, T040). A session shipped before summaries existed, or
    // whose summary does not cover exactly the previous offsets, is rebuilt once from those bytes.
    const prevOffsets = Object.fromEntries(Object.entries(prev.files ?? {}).map(([k, v]) => [k, v?.offset ?? 0]));
    const covered = prev.summary && Object.entries(prevOffsets).every(([k, o]) => (prev.summary.offsets?.[k] ?? -1) === o);
    const summaryBase = covered ? prev.summary : Object.keys(prevOffsets).length
      ? foldSummary(emptySummary(), parseSessionFiles({ sessionId, projectDir, mainBuf, subagents: subBufs, limits: prevOffsets }), prevOffsets)
      : emptySummary();
    st.summary = foldSummary(summaryBase, records, Object.fromEntries(Object.entries(st.files).map(([k, v]) => [k, v?.offset ?? 0])));
    // US3: each turn's feature (records.turns gain feature_id, attribution_rule) and the features rows
    // they reference. Attribution never fails a ship: on any error the turns go without a feature.
    try {
      records.features = await attribute(cfg, { records, signals: mainSignals, st });
    } catch (e) {
      log(dir, { level: 'warn', msg: 'attribution failed', session_id: sessionId, reason: String(e?.message ?? e).slice(0, 120) }, { now });
      records.features = [];
    }
    const sessionKey = JSON.stringify(session);
    const hasNew = records.modelCalls.length + records.turns.length + records.toolUse.length + records.skillUse.length > 0;
    if (!hasNew && sessionKey === prev.lastSessionKey) {
      writeSessionState(dir, sessionId, { ...st, lastShipAt: now });
      return 'nothing';
    }
    const res = await shipRecords({ session: { ...session, shipped_at: new Date(now).toISOString() }, ...records }, shipOpts(cfg, sessionId, range));
    if (!res.ok && !res.spooled) {
      saveEndOnly();
      return 'backoff';
    }
    writeSessionState(dir, sessionId, { ...st, lastShipAt: now, lastSessionKey: sessionKey });
    if (res.ok) writeAtomic(paths(dir).ship, JSON.stringify({ lastOkAt: now }));
    // US3 outcomes, after the batch landed (its features rows exist), at SessionEnd and in sweeps.
    if (res.ok && (how.ended || how.sweep) && st.featuresTouched?.length) {
      try {
        await collectOutcomes(cfg, st, { budgetMs: how.ended ? 3000 : 6000 });
      } catch { /* the next SessionEnd or sweep collects them */ }
    }
    return res.ok ? 'shipped' : 'spooled';
  } finally {
    releaseLock(dir, `session-${sessionId}`);
  }
}

/** Sweep every project directory (research R4); at most once per 15 min per container. */
export async function sweep(cfg) {
  const now = cfg.now();
  const p = paths(cfg.configDir);
  const last = readJson(p.sweep, null)?.completedAt ?? 0;
  if (now - last < SWEEP_INTERVAL_MS) return 'recent';
  if (!acquireLock(cfg.configDir, 'sweep', { now, ttlMs: 10 * 60_000 })) return 'locked';
  try {
    let complete = true;
    let handled = 0;
    for (const s of listSessions(cfg.configDir)) {
      if (handled >= cfg.sweepMaxSessions) {
        complete = false;
        break;
      }
      const r = await shipSession(cfg, s, { sweep: true });
      handled += 1;
      if (r === 'backoff' || r === 'locked') complete = false;
    }
    // US3 housekeeping, best effort: the committed weight table, and ids minted offline for one branch.
    try { await pushWeights(cfg); } catch { /* next sweep */ }
    try { await reconcileOpen(cfg); } catch { /* next sweep */ }
    if (complete) writeAtomic(p.sweep, JSON.stringify({ completedAt: now }));
    return complete ? 'complete' : 'incomplete';
  } finally {
    releaseLock(cfg.configDir, 'sweep');
  }
}

function projectDirOf(cfg, event) {
  const t = event.transcript_path;
  if (typeof t === 'string' && t.endsWith('.jsonl')) return basename(dirname(t));
  return typeof event.cwd === 'string' ? event.cwd.replace(/[^A-Za-z0-9]/g, '-') : null;
}

/** The `hook` command. Never throws, never writes stdout or stderr; the caller exits 0. */
export async function runHook(stdinText, env = process.env) {
  let cfg;
  try {
    cfg = loadConfig(env);
  } catch {
    return;
  }
  try {
    let event;
    try {
      event = JSON.parse(stdinText);
    } catch {
      log(cfg.configDir, { level: 'warn', msg: 'hook: unreadable stdin' }, { now: cfg.now() });
      return;
    }
    const name = event?.hook_event_name;
    const sessionId = UUID.test(String(event?.session_id ?? '')) ? event.session_id : null;
    if (name === 'SessionStart' && sessionId && typeof event.cwd === 'string') writeCwdMarker(cfg.configDir, event.cwd, sessionId, cfg.now());
    if (!cfg.configured) return; // the transcripts stay the source; the first configured sweep catches up
    const projectDir = projectDirOf(cfg, event);

    if (name === 'SessionStart') {
      if (!backoffActive(cfg.configDir, { now: cfg.now() })) await flushAllSpool(cfg);
      await sweep(cfg);
      return;
    }
    if (!sessionId || !projectDir) return;
    if (name === 'Stop') {
      const st = readSessionState(cfg.configDir, sessionId);
      if (st?.lastShipAt && cfg.now() - st.lastShipAt < cfg.intervalMs) return; // no parse, no network
      await shipSession(cfg, { projectDir, sessionId });
      return;
    }
    if (name === 'SessionEnd') {
      await shipSession(cfg, { projectDir, sessionId }, { ended: true, endReason: event.reason });
    }
  } catch (e) {
    log(cfg.configDir, { level: 'error', msg: 'hook failed', error: e?.name ?? 'Error' }, { now: cfg.now() });
  }
}

const iso = (ms) => new Date(ms).toISOString();

/** The `doctor` command's lines (≤ 12). Never prints a URL, host, token or secret. */
export function doctorLines(env = process.env) {
  const cfg = loadConfig(env);
  const now = cfg.now();
  const p = paths(cfg.configDir);
  const lines = ['cc-usage doctor'];
  lines.push(cfg.configured ? 'configured: yes' : `configured: no (missing ${cfg.missing.join(', ')})`);
  const ship = readJson(p.ship, null);
  lines.push(`last ship: ${ship?.lastOkAt ? iso(ship.lastOkAt) : 'never'}`);
  const depth = spoolDepth(cfg.configDir);
  const drops = readSpoolDrops(cfg.configDir);
  lines.push(`spool: ${depth.files} files, ${Math.ceil(depth.bytes / 1024)} KB; drops: ${drops.length}${drops.length ? ` (last ${drops.at(-1).at})` : ''}`);
  const bo = Number((() => { try { return readFileSync(p.backoff, 'utf8'); } catch { return 'x'; } })());
  lines.push(backoffActive(cfg.configDir, { now }) ? `back-off: active until ${iso(bo + BACKOFF_MS)}` : 'back-off: none');
  const tok = tokenState(cfg.configDir, { now });
  lines.push(`token: ${{
    valid: `valid until ${tok.validUntil ? iso(tok.validUntil) : '?'}`,
    expired: 'expired (refreshed on the next ship)',
    rejected: 'client credential rejected',
    'store-rejects': 'store rejects token (redeploy prod-dev-usage after a signing-key rotation)',
    none: 'none yet',
  }[tok.state]}`);
  const unshipped = [];
  for (const s of listSessions(cfg.configDir)) {
    const st = readSessionState(cfg.configDir, s.sessionId);
    let bytes = 0;
    const size = (f) => { try { return statSync(f).size; } catch { return 0; } };
    if (existsSync(s.mainPath)) bytes += Math.max(0, size(s.mainPath) - (st?.files?.main?.offset ?? 0));
    for (const a of s.subagents) if (existsSync(a.transcriptPath)) bytes += Math.max(0, size(a.transcriptPath) - (st?.files?.[`agent-${a.agentId}`]?.offset ?? 0));
    if (bytes > 0) unshipped.push(`${s.sessionId.slice(0, 8)} ${bytes} B`);
  }
  lines.push(unshipped.length === 0
    ? 'unshipped: none'
    : `unshipped: ${unshipped.length} transcripts — ${unshipped.slice(0, 4).join(', ')}${unshipped.length > 4 ? `, +${unshipped.length - 4} more` : ''}`);
  return lines;
}
