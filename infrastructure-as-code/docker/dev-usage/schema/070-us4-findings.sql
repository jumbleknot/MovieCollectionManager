-- Feature 105 US4: findings and the per-activity baseline (data-model.md `findings`, `v_baseline`;
-- FR-028–FR-032). Idempotent, applied on every deploy (research R19).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'usage' AND t.typname = 'finding_status') THEN
    CREATE TYPE usage.finding_status AS ENUM ('open', 'accepted', 'rejected', 'regressed', 'confirmed');
  END IF;
END
$$;

-- One row per rule hit; accepted ones are experiments (FR-032). finding_id is deterministic
-- (`<rule>:<scope>:<week start>`), so re-running analysis upserts. evidence holds numbers and session
-- ids only; suggestion is authored by the rule, never by a model.
CREATE TABLE IF NOT EXISTS usage.findings (
  finding_id       text PRIMARY KEY,
  rule             text NOT NULL,
  scope            text NOT NULL,
  evidence         jsonb NOT NULL DEFAULT '{}',
  sample_size      int NOT NULL DEFAULT 0,
  suggestion       text,
  watch_metric     text,
  counter_metric   text,
  status           usage.finding_status NOT NULL DEFAULT 'open',
  accepted_at      timestamptz,
  baseline_value   numeric,
  after_value      numeric,
  counter_baseline numeric,
  counter_after    numeric,
  created_at       timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON usage.findings TO usage_writer;
REVOKE DELETE, TRUNCATE ON usage.findings FROM usage_writer;

-- One row per session: its dominant activity and every FR-028 metric that is per session. Ratios are
-- NULL where their denominator is zero, so they never enter a median as a false 0.
CREATE OR REPLACE VIEW usage.v_session_metrics AS
WITH dom AS (
  SELECT DISTINCT ON (session_id) session_id, activity
  FROM usage.v_session_activity_mix
  ORDER BY session_id, weighted_tokens DESC, activity
), turn_agg AS (
  SELECT session_id,
    COUNT(*)::numeric AS turns,
    MAX(context_tokens_at_start) AS max_context,
    SUM(rereads)::numeric AS rereads,
    SUM(cache_write_5m_tokens + cache_write_1h_tokens) FILTER (WHERE idle_gap_s > 300)::numeric AS idle_writes,
    SUM(cache_write_5m_tokens + cache_write_1h_tokens)::numeric AS writes
  FROM usage.v_turn_totals GROUP BY session_id
), tool_agg AS (
  SELECT session_id, SUM(result_bytes)::numeric AS result_bytes,
    SUM(rtk_calls) FILTER (WHERE tool = 'Bash')::numeric AS rtk, SUM(calls) FILTER (WHERE tool = 'Bash')::numeric AS bash
  FROM usage.tool_use GROUP BY session_id
), call_agg AS (
  SELECT c.session_id,
    SUM(c.weighted_tokens) AS weighted,
    SUM(c.weighted_tokens) FILTER (WHERE c.model ILIKE '%opus%') AS premium,
    SUM(c.weighted_tokens) FILTER (WHERE f.first_red_at IS NOT NULL AND c.ts >= f.first_red_at) AS rework
  FROM usage.v_call_weighted c
  LEFT JOIN usage.turns t ON t.session_id = c.session_id AND t.turn_seq = c.turn_seq
  LEFT JOIN usage.features f ON f.feature_id = t.feature_id
  GROUP BY c.session_id
), ci AS (
  SELECT t.session_id,
    AVG(CASE WHEN f.ci_runs_red = 0 THEN 1.0 ELSE 0.0 END) AS first_pass
  FROM (SELECT DISTINCT session_id, feature_id FROM usage.turns WHERE feature_id IS NOT NULL) t
  JOIN usage.features f ON f.feature_id = t.feature_id
  WHERE f.ci_runs_red + f.ci_runs_green > 0
  GROUP BY t.session_id
)
SELECT
  s.session_id, s.started_at, COALESCE(d.activity, 'unclassified') AS activity,
  s.weighted_tokens,
  s.floor_tokens::numeric AS floor_tokens,
  (s.cache_read_tokens::numeric / NULLIF(s.input_tokens + s.cache_read_tokens + s.cache_write_5m_tokens + s.cache_write_1h_tokens, 0)) AS cache_read_ratio,
  (COALESCE(ta.idle_writes, 0) / NULLIF(ta.writes, 0)) AS idle_tax,
  (ta.max_context - s.floor_tokens)::numeric AS context_growth,
  s.compactions::numeric AS compactions,
  (COALESCE(tl.result_bytes, 0) / NULLIF(ta.turns, 0)) AS tool_output_bytes,
  (tl.rtk / NULLIF(tl.bash, 0)) AS rtk_share,
  (ta.rereads / NULLIF(ta.turns, 0)) AS reread_rate,
  (s.subagent_tokens::numeric / NULLIF(s.main_tokens + s.subagent_tokens, 0)) AS subagent_share,
  (COALESCE(ca.premium, 0) / NULLIF(ca.weighted, 0)) AS premium_share,
  COALESCE(ca.rework / NULLIF(ca.weighted, 0), 0) AS rework_share,
  ci.first_pass AS ci_first_pass_rate
FROM usage.v_session_totals s
LEFT JOIN dom d ON d.session_id = s.session_id
LEFT JOIN turn_agg ta ON ta.session_id = s.session_id
LEFT JOIN tool_agg tl ON tl.session_id = s.session_id
LEFT JOIN call_agg ca ON ca.session_id = s.session_id
LEFT JOIN ci ON ci.session_id = s.session_id;

-- The developer's own baseline (FR-028): per activity and metric, the median, p90, p10 and sample size
-- over sessions started in the trailing 28 days; plus tokens per merged PR over the features merged in
-- that window (activity '(features)'). data_days is the age of the whole store, for the 14-day rule.
CREATE OR REPLACE VIEW usage.v_baseline AS
WITH span AS (
  SELECT GREATEST(0, EXTRACT(EPOCH FROM (now() - MIN(started_at))) / 86400)::numeric AS data_days FROM usage.sessions
), vals AS (
  SELECT m.activity, v.metric, v.value
  FROM usage.v_session_metrics m
  CROSS JOIN LATERAL (VALUES
    ('weighted_tokens', m.weighted_tokens), ('floor_tokens', m.floor_tokens), ('cache_read_ratio', m.cache_read_ratio),
    ('idle_tax', m.idle_tax), ('context_growth', m.context_growth), ('compactions', m.compactions),
    ('tool_output_bytes', m.tool_output_bytes), ('rtk_share', m.rtk_share), ('reread_rate', m.reread_rate),
    ('subagent_share', m.subagent_share), ('premium_share', m.premium_share), ('rework_share', m.rework_share),
    ('ci_first_pass_rate', m.ci_first_pass_rate)
  ) AS v(metric, value)
  WHERE m.started_at >= now() - interval '28 days' AND v.value IS NOT NULL
  UNION ALL
  SELECT '(features)', 'tokens_per_merged_pr', weighted_tokens
  FROM usage.v_feature_totals WHERE pr_state = 'merged' AND merged_at >= now() - interval '28 days'
)
SELECT
  vals.activity, vals.metric,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY vals.value)::numeric AS median,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY vals.value)::numeric AS p90,
  percentile_cont(0.1) WITHIN GROUP (ORDER BY vals.value)::numeric AS p10,
  COUNT(*)::bigint AS n,
  round((SELECT data_days FROM span), 1) AS data_days
FROM vals
GROUP BY vals.activity, vals.metric;

GRANT SELECT ON usage.v_session_metrics, usage.v_baseline TO usage_writer, usage_reader;
