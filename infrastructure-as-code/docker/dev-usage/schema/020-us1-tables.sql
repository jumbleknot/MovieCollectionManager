-- Feature 105 US1 tables (data-model.md). Idempotent: CREATE … IF NOT EXISTS; later stories add
-- columns with ADD COLUMN IF NOT EXISTS in their own files. No column holds content or a path.
-- Totals are never stored: they are views over model_calls (FR-008).

CREATE TABLE IF NOT EXISTS usage.sessions (
  session_id        uuid PRIMARY KEY,
  project_dir       text NOT NULL,
  starting_worktree text,
  starting_branch   text,
  entrypoint        text,
  cc_version        text,
  started_at        timestamptz,
  ended_at          timestamptz,
  end_reason        text,
  compactions       int NOT NULL DEFAULT 0,
  capture_status    usage.capture_status NOT NULL DEFAULT 'partial',
  partial_reasons   text[] NOT NULL DEFAULT '{}',
  manual_tag        text,
  parser_version    int NOT NULL DEFAULT 1,
  shipped_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage.model_calls (
  session_id            uuid NOT NULL REFERENCES usage.sessions (session_id),
  message_id            text NOT NULL,
  request_id            text,
  turn_seq              int,
  agent_id              text,
  ts                    timestamptz,
  model                 text,
  input_tokens          bigint NOT NULL DEFAULT 0,
  output_tokens         bigint NOT NULL DEFAULT 0,
  cache_read_tokens     bigint NOT NULL DEFAULT 0,
  cache_write_5m_tokens bigint NOT NULL DEFAULT 0,
  cache_write_1h_tokens bigint NOT NULL DEFAULT 0,
  thinking_tokens       bigint,
  skill                 text,
  PRIMARY KEY (session_id, message_id)
);

CREATE TABLE IF NOT EXISTS usage.turns (
  session_id              uuid NOT NULL REFERENCES usage.sessions (session_id),
  turn_seq                int NOT NULL,
  origin                  usage.turn_origin NOT NULL DEFAULT 'other',
  started_at              timestamptz,
  ended_at                timestamptz,
  idle_gap_s              int NOT NULL DEFAULT 0,
  context_tokens_at_start bigint NOT NULL DEFAULT 0,
  areas                   text[] NOT NULL DEFAULT '{}',
  rereads                 int NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, turn_seq)
);

CREATE TABLE IF NOT EXISTS usage.tool_use (
  session_id     uuid NOT NULL,
  turn_seq       int NOT NULL,
  tool           text NOT NULL,
  command_family text NOT NULL DEFAULT '',
  calls          int NOT NULL DEFAULT 0,
  result_bytes   bigint NOT NULL DEFAULT 0,
  rtk_calls      int NOT NULL DEFAULT 0,
  subagent_type  text,
  PRIMARY KEY (session_id, turn_seq, tool, command_family),
  FOREIGN KEY (session_id, turn_seq) REFERENCES usage.turns (session_id, turn_seq)
);

CREATE TABLE IF NOT EXISTS usage.skill_use (
  session_id  uuid NOT NULL REFERENCES usage.sessions (session_id),
  skill       text NOT NULL,
  invocations int NOT NULL DEFAULT 0,
  first_turn  int,
  PRIMARY KEY (session_id, skill)
);

CREATE INDEX IF NOT EXISTS model_calls_ts_idx ON usage.model_calls (ts);
CREATE INDEX IF NOT EXISTS sessions_started_at_idx ON usage.sessions (started_at);
