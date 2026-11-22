// The privacy allowlist for feature 105 (FR-012, FR-003; contracts/store-http.md "Record shape
// constraints"). ship-records.mjs applies shapeRecords() to EVERY batch before it leaves the
// container.
//
// An explicit allowlist per table, from data-model.md: any key not listed is DROPPED (not escaped,
// not truncated), so a parser regression that starts emitting `command` or `text` ships nothing.
// Value checks back the column list up: a string over 200 characters, or one that looks like a
// host path, is replaced by null; array members failing the same check are removed.

export const TABLE_COLUMNS = {
  sessions: [
    'session_id', 'project_dir', 'starting_worktree', 'starting_branch', 'entrypoint', 'cc_version',
    'started_at', 'ended_at', 'end_reason', 'compactions', 'capture_status', 'partial_reasons',
    'parser_version', 'shipped_at',
  ],
  model_calls: [
    'session_id', 'message_id', 'request_id', 'turn_seq', 'agent_id', 'ts', 'model', 'input_tokens',
    'output_tokens', 'cache_read_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens',
    'thinking_tokens', 'skill',
  ],
  turns: [
    'session_id', 'turn_seq', 'origin', 'started_at', 'ended_at', 'idle_gap_s',
    'context_tokens_at_start', 'areas', 'rereads',
    // US3: the label, the rule that fired, the feature and how it was decided — never the inputs.
    'activity', 'activity_rule', 'feature_id', 'attribution_rule',
  ],
  tool_use: ['session_id', 'turn_seq', 'tool', 'command_family', 'calls', 'result_bytes', 'rtk_calls', 'subagent_type'],
  skill_use: ['session_id', 'skill', 'invocations', 'first_turn'],
  features: [
    'feature_id', 'branch', 'first_seen_at', 'kind', 'spec_dir', 'spec_number', 'commits', 'lines_added',
    'lines_removed', 'tasks_total', 'tasks_done', 'pr_number', 'pr_state', 'merged_at', 'ci_runs_red',
    'ci_runs_green', 'first_red_at', 'backlog_closed', 'collected_at',
  ],
  token_weights: ['as_of', 'input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'source'],
};

const MAX_STRING = 200;
const HOST_PATH = /^\/|\/(workspaces|home|tmp)\/|\.ts\.net\b/i;

function safeString(v) {
  return v.length <= MAX_STRING && !HOST_PATH.test(v);
}

function safeValue(v) {
  if (typeof v === 'string') return safeString(v) ? v : null;
  if (Array.isArray(v)) return v.filter((x) => (typeof x === 'string' ? safeString(x) : typeof x === 'number'));
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  return null; // nested objects never ship
}

/** Keep only the allowlisted columns of `table`, with value checks. Unknown table → nothing. */
export function shapeRows(table, rows) {
  const cols = TABLE_COLUMNS[table];
  if (!cols) return [];
  return (rows ?? []).map((row) => {
    const out = {};
    for (const c of cols) if (Object.hasOwn(row, c)) out[c] = safeValue(row[c]);
    return out;
  });
}

/** Parser records → the per-table batches the shipper sends. */
export function shapeRecords(records) {
  return {
    sessions: shapeRows('sessions', records.session ? [records.session] : []),
    features: shapeRows('features', records.features ?? []),
    model_calls: shapeRows('model_calls', records.modelCalls),
    turns: shapeRows('turns', records.turns),
    tool_use: shapeRows('tool_use', records.toolUse),
    skill_use: shapeRows('skill_use', records.skillUse),
  };
}
