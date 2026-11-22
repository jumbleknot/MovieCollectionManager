// Pure Claude Code transcript parser for feature 105 (FR-002–FR-005; research R1–R3).
//
// Input: the bytes of one JSONL transcript and a carried state (which holds the byte offset already
// consumed). Output: the records derived from the NEW complete lines, plus the next state. No IO.
//
// What it reads and what it never emits:
//   - assistant lines: message.id (one model call per id, research R2), usage, model, attributionSkill,
//     and tool_use NAMES. Tool inputs are read only to derive a command family, a top-level area and
//     a re-read count; the input text itself is never emitted.
//   - user lines: turn boundaries (origin.kind) and tool-result SIZES (never the content).
//   - system compact_boundary lines: counted.
//   - every other line type is ignored (research R1).
// An assistant line without message.id or usage, or a complete line that is not JSON, is format
// drift: the session becomes `partial` with reason `format-drift` (FR-005), never a zero.
import { createHash } from 'node:crypto';

/** Bump when parsing or labelling changes what a transcript yields (data-model.md sessions.parser_version). */
export const PARSER_VERSION = 1;

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']);
const READ_TOOLS = new Set(['Read']);
const SAFE_WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['rtk', 'sudo', 'env', 'time', 'nice', 'command', 'exec']);
const REREAD_THRESHOLD = 3;

/** A fresh state for one transcript file. Serializable as JSON (it lives in local state). */
export function initialState() {
  return {
    offset: 0,
    turnSeq: 0,
    turn: null, // the current (possibly unfinished) turn, with its tool aggregates
    lastTurnEndedAt: null,
    seen: [], // message ids already emitted
    reads: {}, // sha1(path) → read count, session-wide
    pending: {}, // tool_use id → [turnSeq, tool, family] awaiting its result
    agentSpawns: {}, // Agent/Task tool_use id → turnSeq (for subagent attribution)
    skills: {}, // skill → { invocations, first_turn, lastTurn }
    compactions: 0,
    reasons: [],
    meta: null, // first-line session facts
  };
}

/**
 * The command family of a Bash command: its first real word, sanitized. Leading `VAR=value`
 * assignments, a `cd <dir> &&` prefix and wrappers such as `rtk` are skipped; anything that is not
 * a plain word (a substitution, a quoted string) is `other`, so no fragment of a value can ship.
 */
export function commandFamily(command) {
  let words = String(command ?? '').trim().split(/\s+/).filter(Boolean);
  if (words[0] === 'cd') {
    const amp = words.indexOf('&&');
    words = amp === -1 ? [] : words.slice(amp + 1);
  }
  while (words.length && (ASSIGNMENT.test(words[0]) || WRAPPERS.has(words[0]))) {
    if (ASSIGNMENT.test(words[0]) && /\$\(|`/.test(words[0])) {
      // `X=$(cmd …)` may span words; skip to the word that closes it.
      while (words.length && !/\)$/.test(words[0])) words.shift();
    }
    words.shift();
  }
  const first = words[0];
  if (!first) return 'other';
  const base = first.includes('/') ? first.slice(first.lastIndexOf('/') + 1) : first;
  return SAFE_WORD.test(base) ? base : 'other';
}

const isRtk = (command) => {
  const words = String(command ?? '').trim().split(/\s+/);
  while (words.length && ASSIGNMENT.test(words[0])) words.shift();
  return words[0] === 'rtk';
};

/** Top-level repository area of a tool path, or null. Paths are used here and never emitted. */
function areaOf(path, cwd) {
  if (typeof path !== 'string' || path === '') return null;
  let rel = null;
  const wt = path.match(/\/worktrees\/[^/]+\/(.+)$/);
  if (wt) rel = wt[1];
  else if (cwd && path.startsWith(`${cwd}/`)) rel = path.slice(cwd.length + 1);
  else if (!path.startsWith('/')) rel = path.replace(/^\.\//, '');
  if (rel === null) return null;
  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const area = parts.length === 1 ? '(root)' : parts[0];
  return area === '(root)' || SAFE_WORD.test(area) ? area : null;
}

const toolPath = (input) => input?.file_path ?? input?.notebook_path ?? input?.path ?? null;
const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const secondsBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));

function resultBytes(block, toolUseResult, loneResult) {
  if (loneResult && Number.isFinite(toolUseResult?.persistedOutputSize)) return toolUseResult.persistedOutputSize;
  const c = block.content;
  if (typeof c === 'string') return Buffer.byteLength(c);
  if (Array.isArray(c)) return c.reduce((n, p) => n + (typeof p?.text === 'string' ? Buffer.byteLength(p.text) : 0), 0);
  return 0;
}

function newTurn(seq, origin, ts, prevEndedAt) {
  return {
    turn_seq: seq,
    origin,
    started_at: ts,
    ended_at: ts,
    idle_gap_s: prevEndedAt ? secondsBetween(prevEndedAt, ts) : 0,
    context_tokens_at_start: null,
    areas: [],
    rereads: 0,
    tools: {}, // `${tool}\u0000${family}` → aggregate row (without session_id)
    rereadFiles: [],
  };
}

function turnRecord(sessionId, t) {
  return {
    session_id: sessionId,
    turn_seq: t.turn_seq,
    origin: t.origin,
    started_at: t.started_at,
    ended_at: t.ended_at,
    idle_gap_s: t.idle_gap_s,
    context_tokens_at_start: t.context_tokens_at_start ?? 0,
    areas: [...t.areas].sort(),
    rereads: t.rereads,
  };
}

function toolRecords(sessionId, t) {
  return Object.values(t.tools).map((r) => ({ session_id: sessionId, turn_seq: t.turn_seq, ...r }));
}

function originOf(kind) {
  if (kind === 'human') return 'human';
  if (kind === 'task-notification') return 'task_notification';
  return 'other';
}

/**
 * Parse the complete lines after `state.offset`.
 *
 * @param {Buffer|string} input  the whole file (or a prefix of it)
 * @param {object} state         from initialState() or a previous call
 * @param {{sessionId: string, projectDir: string, agentId?: string|null, parentTurn?: number|null}} opts
 *   agentId/parentTurn: parse a SUBAGENT file — its calls carry agent_id and the parent turn.
 */
export function parseTranscript(input, state, { sessionId, projectDir, agentId = null, parentTurn = null }) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  const st = structuredClone(state);
  const seen = new Set(st.seen);
  const modelCalls = [];
  const touchedTurns = new Map(); // turn_seq → turn object (finished or current)
  const touchedSkills = new Set();
  const sub = agentId !== null;

  const end = buf.lastIndexOf(0x0a);
  const text = end >= st.offset ? buf.subarray(st.offset, end + 1).toString('utf8') : '';

  const ensureTurn = (ts) => {
    if (!st.turn) {
      st.turnSeq += 1;
      st.turn = newTurn(st.turnSeq, 'other', ts, st.lastTurnEndedAt);
    }
    return st.turn;
  };
  const touch = (t) => touchedTurns.set(t.turn_seq, t);
  const addReason = (r) => { if (!st.reasons.includes(r)) st.reasons.push(r); };

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      addReason('format-drift');
      continue;
    }
    if (!st.meta && j.sessionId && j.timestamp && (j.type === 'user' || j.type === 'assistant' || j.type === 'system')) {
      st.meta = {
        started_at: j.timestamp,
        starting_worktree: typeof j.cwd === 'string' ? j.cwd.split('/').filter(Boolean).pop() ?? null : null,
        starting_branch: j.gitBranch ?? null,
        entrypoint: j.entrypoint ?? null,
        cc_version: j.version ?? null,
      };
    }

    if (j.type === 'system') {
      if (j.subtype === 'compact_boundary') st.compactions += 1;
      continue;
    }

    if (j.type === 'user') {
      if (sub) continue;
      const kind = j.origin?.kind;
      if (kind) {
        if (st.turn) {
          st.lastTurnEndedAt = st.turn.ended_at;
          touch(st.turn);
        }
        st.turnSeq += 1;
        st.turn = newTurn(st.turnSeq, originOf(kind), j.timestamp, st.lastTurnEndedAt);
        touch(st.turn);
        continue;
      }
      const blocks = Array.isArray(j.message?.content) ? j.message.content.filter((b) => b?.type === 'tool_result') : [];
      for (const b of blocks) {
        const p = st.pending[b.tool_use_id];
        if (!p) continue;
        delete st.pending[b.tool_use_id];
        const [seq, tool, family] = p;
        const t = st.turn && st.turn.turn_seq === seq ? st.turn : null;
        if (!t) continue;
        const row = t.tools[`${tool}\u0000${family}`];
        row.result_bytes += resultBytes(b, j.toolUseResult, blocks.length === 1);
        if (tool === 'Agent' || tool === 'Task') {
          const at = j.toolUseResult?.agentType;
          if (typeof at === 'string' && SAFE_WORD.test(at)) row.subagent_type = at;
        }
        if (j.timestamp) t.ended_at = j.timestamp;
        touch(t);
      }
      continue;
    }

    if (j.type !== 'assistant') continue;
    const msg = j.message ?? {};
    if (!msg.id || !msg.usage) {
      addReason('format-drift');
      continue;
    }
    const t = sub ? null : ensureTurn(j.timestamp);
    if (t) {
      if (j.timestamp) t.ended_at = j.timestamp;
      touch(t);
    }
    const firstTime = !seen.has(msg.id);
    if (firstTime) {
      seen.add(msg.id);
      const u = msg.usage;
      const cw = u.cache_creation_input_tokens ?? 0;
      const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const call = {
        session_id: sessionId,
        message_id: msg.id,
        request_id: j.requestId ?? null,
        turn_seq: sub ? parentTurn : t.turn_seq,
        agent_id: sub ? agentId : null,
        ts: j.timestamp,
        model: msg.model ?? null,
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_tokens: u.cache_read_input_tokens ?? 0,
        cache_write_5m_tokens: cw - w1h,
        cache_write_1h_tokens: w1h,
        thinking_tokens: u.output_tokens_details?.thinking_tokens ?? null,
        skill: typeof j.attributionSkill === 'string' && SAFE_WORD.test(j.attributionSkill) ? j.attributionSkill : null,
      };
      modelCalls.push(call);
      if (t && t.context_tokens_at_start === null) {
        t.context_tokens_at_start = call.input_tokens + call.cache_read_tokens + cw;
      }
      if (t && call.skill) {
        const s = (st.skills[call.skill] ??= { invocations: 0, first_turn: t.turn_seq, lastTurn: 0 });
        if (s.lastTurn !== t.turn_seq) {
          s.invocations += 1;
          s.lastTurn = t.turn_seq;
        }
        touchedSkills.add(call.skill);
      }
    }
    if (!t) continue; // subagent tool use is not aggregated (its calls carry the parent turn)

    // Tool use: one content block per streamed line, so every block is counted exactly once.
    for (const c of msg.content ?? []) {
      if (c?.type !== 'tool_use' || typeof c.name !== 'string') continue;
      const tool = SAFE_WORD.test(c.name) ? c.name : 'other';
      const family = tool === 'Bash' ? commandFamily(c.input?.command) : '';
      const key = `${tool}\u0000${family}`;
      const row = (t.tools[key] ??= { tool, command_family: family, calls: 0, result_bytes: 0, rtk_calls: 0, subagent_type: null });
      row.calls += 1;
      if (tool === 'Bash' && isRtk(c.input?.command)) row.rtk_calls += 1;
      if (c.id) st.pending[c.id] = [t.turn_seq, tool, family];
      if ((tool === 'Agent' || tool === 'Task') && c.id) st.agentSpawns[c.id] = t.turn_seq;
      if (FILE_TOOLS.has(tool)) {
        const p = toolPath(c.input);
        const area = areaOf(p, j.cwd);
        if (area && !t.areas.includes(area)) t.areas.push(area);
        if (READ_TOOLS.has(tool) && typeof p === 'string') {
          const h = sha1(p);
          st.reads[h] = (st.reads[h] ?? 0) + 1;
          if (st.reads[h] > REREAD_THRESHOLD && !t.rereadFiles.includes(h)) {
            t.rereadFiles.push(h);
            t.rereads = t.rereadFiles.length;
          }
        }
      }
    }
  }

  st.offset = end >= st.offset ? end + 1 : st.offset;
  st.seen = [...seen];
  const turns = [...touchedTurns.values()].sort((a, b) => a.turn_seq - b.turn_seq);
  return {
    records: {
      session: sessionRecord(sessionId, projectDir, st),
      modelCalls,
      turns: turns.map((x) => turnRecord(sessionId, x)),
      toolUse: turns.flatMap((x) => toolRecords(sessionId, x)),
      skillUse: [...touchedSkills].sort().map((skill) => ({
        session_id: sessionId, skill, invocations: st.skills[skill].invocations, first_turn: st.skills[skill].first_turn,
      })),
    },
    state: st,
  };
}

function sessionRecord(sessionId, projectDir, st) {
  return {
    session_id: sessionId,
    project_dir: projectDir,
    starting_worktree: st.meta?.starting_worktree ?? null,
    starting_branch: st.meta?.starting_branch ?? null,
    entrypoint: st.meta?.entrypoint ?? null,
    cc_version: st.meta?.cc_version ?? null,
    started_at: st.meta?.started_at ?? null,
    compactions: st.compactions,
    capture_status: 'partial',
    partial_reasons: [...st.reasons],
    parser_version: PARSER_VERSION,
  };
}

/**
 * `sessions.capture_status` (data-model.md state machine): `not_captured` without a main transcript;
 * `complete` only once the session ended cleanly with no gap; otherwise `partial`.
 */
export function captureStatus({ hasMain, reasons, ended }) {
  if (!hasMain) return 'not_captured';
  return ended && reasons.length === 0 ? 'complete' : 'partial';
}

/**
 * Parse a whole session in one pass (tests, the oracle check, a first backfill).
 * @param {{sessionId: string, projectDir: string, main: Buffer|null,
 *          subagents: {agentId: string, meta: object, transcript: Buffer|null}[], ended?: boolean}} s
 */
export function summarizeSession({ sessionId, projectDir, main, subagents = [], ended = false }) {
  if (!main) {
    return {
      session: {
        session_id: sessionId, project_dir: projectDir, starting_worktree: null, starting_branch: null,
        entrypoint: null, cc_version: null, started_at: null, compactions: 0,
        capture_status: 'not_captured', partial_reasons: [], parser_version: PARSER_VERSION,
      },
      modelCalls: [], turns: [], toolUse: [], skillUse: [],
    };
  }
  const m = parseTranscript(main, initialState(), { sessionId, projectDir });
  const reasons = [...m.state.reasons];
  const modelCalls = [...m.records.modelCalls];
  // Session-wide dedup (T077): a forked subagent repeats its parent's calls under the same message id.
  const claimed = new Set(modelCalls.map((c) => c.message_id));
  for (const s of subagents) {
    if (!s.transcript) {
      if (!reasons.includes('subagent-transcript-missing')) reasons.push('subagent-transcript-missing');
      continue;
    }
    const parentTurn = m.state.agentSpawns[s.meta?.toolUseId] ?? null;
    const r = parseTranscript(s.transcript, initialState(), { sessionId, projectDir, agentId: s.agentId, parentTurn });
    for (const why of r.state.reasons) if (!reasons.includes(why)) reasons.push(why);
    modelCalls.push(...r.records.modelCalls.filter((c) => !claimed.has(c.message_id) && claimed.add(c.message_id)));
  }
  return {
    session: {
      ...m.records.session,
      capture_status: captureStatus({ hasMain: true, reasons, ended }),
      partial_reasons: reasons,
    },
    modelCalls,
    turns: m.records.turns,
    toolUse: m.records.toolUse,
    skillUse: m.records.skillUse,
  };
}
