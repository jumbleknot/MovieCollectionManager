// Feature 105 US2 — the per-session incremental summary kept in local state (tasks.md T040): `now` adds
// the unshipped tail to it instead of re-parsing a whole transcript. Shared by capture (which folds
// every shipped batch in) and query (which folds the tail in, read-only).
import { initialState, parseTranscript } from './parse-transcript.mjs';

export const TOKEN_TYPES = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];
const callTotal = (c) => c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_5m_tokens + c.cache_write_1h_tokens;

export const emptySummary = () => ({
  tokens: Object.fromEntries(TOKEN_TYPES.map((t) => [t, 0])),
  main: 0,
  sub: 0,
  calls: 0,
  contextNow: 0,
  contextTs: null,
  tools: {}, // `${turn}\0${tool}\0${family}` → { tool, family, calls, bytes } (tool rows are cumulative per turn)
  turnActivity: {}, // turn_seq → activity (US3; the latest label of a growing turn wins)
  turnTokens: {}, // turn_seq → tokens of its calls (main and subagent)
  offsets: {},
});

/** Fold newly parsed records into a summary (pure). */
export function foldSummary(summary, { modelCalls = [], toolUse = [], turns = [] }, offsets = {}) {
  const s = structuredClone(summary ?? emptySummary());
  s.turnActivity ??= {};
  s.turnTokens ??= {};
  for (const t of turns) if (t.activity) s.turnActivity[t.turn_seq] = t.activity;
  for (const c of modelCalls) {
    for (const t of TOKEN_TYPES) s.tokens[t] += c[`${t}_tokens`] ?? 0;
    const total = callTotal(c);
    s.calls += 1;
    if (c.turn_seq !== null && c.turn_seq !== undefined) s.turnTokens[c.turn_seq] = (s.turnTokens[c.turn_seq] ?? 0) + total;
    if (c.agent_id === null) {
      s.main += total;
      if (!s.contextTs || (c.ts && c.ts >= s.contextTs)) {
        s.contextNow = c.input_tokens + c.cache_read_tokens + c.cache_write_5m_tokens + c.cache_write_1h_tokens;
        s.contextTs = c.ts ?? s.contextTs;
      }
    } else {
      s.sub += total;
    }
  }
  for (const r of toolUse) {
    s.tools[`${r.turn_seq}\u0000${r.tool}\u0000${r.command_family}`] = { tool: r.tool, family: r.command_family, calls: r.calls, bytes: r.result_bytes };
  }
  s.offsets = { ...s.offsets, ...offsets };
  return s;
}

/**
 * Parse a session's files from the given per-file states, deduping model calls session-wide (T077).
 * `limits` caps each file at a byte offset (used to rebuild a summary for bytes shipped before it existed).
 */
export function parseSessionFiles({ sessionId, projectDir, mainBuf, subagents, states = {}, limits = null }) {
  const claimed = new Set(Object.values(states).flatMap((f) => f?.seen ?? []));
  const keep = (calls) => calls.filter((c) => !claimed.has(c.message_id) && claimed.add(c.message_id));
  const cut = (buf, key) => (limits && buf ? buf.subarray(0, limits[key] ?? 0) : buf);
  const out = { modelCalls: [], toolUse: [], turns: [], offsets: {} };
  const m = cut(mainBuf, 'main');
  if (m) {
    const r = parseTranscript(m, states.main ?? initialState(), { sessionId, projectDir });
    out.modelCalls.push(...keep(r.records.modelCalls));
    out.toolUse.push(...r.records.toolUse);
    out.turns.push(...r.records.turns);
    out.offsets.main = r.state.offset;
  }
  for (const s of subagents) {
    const key = `agent-${s.agentId}`;
    const buf = cut(s.buf, key);
    if (!buf) continue;
    const r = parseTranscript(buf, states[key] ?? initialState(), { sessionId, projectDir, agentId: s.agentId, parentTurn: null });
    out.modelCalls.push(...keep(r.records.modelCalls));
    out.offsets[key] = r.state.offset;
  }
  return out;
}


/** The activity with the most tokens in this session so far, or null before any labelled turn. */
export function dominantActivity(summary) {
  const by = {};
  for (const [seq, a] of Object.entries(summary.turnActivity ?? {})) by[a] = (by[a] ?? 0) + (summary.turnTokens?.[seq] ?? 0);
  const best = Object.entries(by).sort((x, y) => y[1] - x[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}
