-- Feature 105 US3 tables and turn columns (data-model.md `features`, `token_weights`, `turns`).
-- Idempotent, applied on every deploy (research R19).
--
-- Why 035 and not 050 (tasks.md T053 deviation): the files re-apply IN NAME ORDER, and 040 defines
-- v_turn_totals. Its US3 columns (activity, feature_id, weighted tokens) must exist before 040 runs, or
-- 040 would have to omit them — and a later file appending them would make the NEXT re-apply of 040
-- fail with "cannot drop columns from view". So the columns land here, before 040, and 040 itself
-- carries the complete view.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'usage' AND t.typname = 'attribution_rule') THEN
    CREATE TYPE usage.attribution_rule AS ENUM ('worktree', 'worktree-majority', 'inherited', 'session-branch', 'main');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'usage' AND t.typname = 'feature_kind') THEN
    CREATE TYPE usage.feature_kind AS ENUM ('spec', 'no-spec');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'usage' AND t.typname = 'pr_state') THEN
    CREATE TYPE usage.pr_state AS ENUM ('none', 'open', 'merged', 'closed', 'abandoned');
  END IF;
END
$$;

-- One row per piece of work on a non-main branch (FR-034). `branch` is NOT unique: a reused name is a
-- new feature (FR-035). tasks_* NULL means "not applicable" (no task list), never 0 (FR-025).
CREATE TABLE IF NOT EXISTS usage.features (
  feature_id     text PRIMARY KEY,
  branch         text NOT NULL,
  first_seen_at  timestamptz,
  kind           usage.feature_kind NOT NULL DEFAULT 'no-spec',
  spec_dir       text,
  spec_number    int,
  commits        int NOT NULL DEFAULT 0,
  lines_added    int NOT NULL DEFAULT 0,
  lines_removed  int NOT NULL DEFAULT 0,
  tasks_total    int,
  tasks_done     int,
  pr_number      int,
  pr_state       usage.pr_state NOT NULL DEFAULT 'none',
  merged_at      timestamptz,
  ci_runs_red    int NOT NULL DEFAULT 0,
  ci_runs_green  int NOT NULL DEFAULT 0,
  first_red_at   timestamptz,
  backlog_closed int NOT NULL DEFAULT 0,
  collected_at   timestamptz
);
CREATE INDEX IF NOT EXISTS features_branch_idx ON usage.features (branch);

-- The dated weight table (FR-026): ratios to the uncached input price. The latest as_of applies.
CREATE TABLE IF NOT EXISTS usage.token_weights (
  as_of          date PRIMARY KEY,
  input          numeric NOT NULL,
  output         numeric NOT NULL,
  cache_read     numeric NOT NULL,
  cache_write_5m numeric NOT NULL,
  cache_write_1h numeric NOT NULL,
  source         text
);

ALTER TABLE usage.turns
  ADD COLUMN IF NOT EXISTS activity         text,
  ADD COLUMN IF NOT EXISTS activity_rule    text,
  ADD COLUMN IF NOT EXISTS feature_id       text REFERENCES usage.features (feature_id),
  ADD COLUMN IF NOT EXISTS attribution_rule usage.attribution_rule;
CREATE INDEX IF NOT EXISTS turns_feature_idx ON usage.turns (feature_id);

GRANT SELECT, INSERT, UPDATE ON usage.features, usage.token_weights TO usage_writer;
REVOKE DELETE, TRUNCATE ON usage.features, usage.token_weights FROM usage_writer;

-- Every call weighted by the LATEST weights; unweighted (all ratios 1) until a weight row exists.
CREATE OR REPLACE VIEW usage.v_call_weighted AS
WITH w AS (SELECT * FROM usage.token_weights ORDER BY as_of DESC LIMIT 1)
SELECT
  c.session_id, c.message_id, c.turn_seq, c.agent_id, c.ts, c.model,
  c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_write_5m_tokens, c.cache_write_1h_tokens,
  (c.input_tokens * COALESCE(w.input, 1) + c.output_tokens * COALESCE(w.output, 1)
   + c.cache_read_tokens * COALESCE(w.cache_read, 1) + c.cache_write_5m_tokens * COALESCE(w.cache_write_5m, 1)
   + c.cache_write_1h_tokens * COALESCE(w.cache_write_1h, 1))::numeric AS weighted_tokens
FROM usage.model_calls c
LEFT JOIN w ON true;

GRANT SELECT ON usage.v_call_weighted TO usage_writer, usage_reader;
