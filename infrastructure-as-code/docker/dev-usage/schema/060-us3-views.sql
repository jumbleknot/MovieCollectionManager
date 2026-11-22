-- Feature 105 US3 views (data-model.md "Views"; FR-026, FR-027, FR-037, FR-039). CREATE OR REPLACE,
-- idempotent. Read by the skill and Grafana (usage_reader sees views only).
--
-- Conservation (SC-010): every model call belongs to exactly one bucket. A call whose turn has a
-- feature counts for that feature; every other call — a main-branch turn, an unattributed turn, or a
-- call whose turn row is missing (a subagent call with no known parent turn) — counts as no feature.
-- So SUM(v_feature_totals) + v_no_feature_totals = SUM(v_session_totals), for every token type.

CREATE OR REPLACE VIEW usage.v_call_attributed AS
SELECT
  c.session_id, c.message_id, c.turn_seq, c.agent_id, c.ts,
  c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_write_5m_tokens, c.cache_write_1h_tokens,
  c.weighted_tokens,
  (c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_5m_tokens + c.cache_write_1h_tokens)::bigint AS total_tokens,
  t.feature_id,
  COALESCE(t.activity, 'unclassified') AS activity
FROM usage.v_call_weighted c
LEFT JOIN usage.turns t ON t.session_id = c.session_id AND t.turn_seq = c.turn_seq;

-- Share of weighted tokens per activity per session; `dominant` marks the largest (ties: all of them).
CREATE OR REPLACE VIEW usage.v_session_activity_mix AS
WITH a AS (
  SELECT session_id, activity, COUNT(DISTINCT turn_seq)::bigint AS turns, SUM(weighted_tokens)::numeric AS weighted_tokens
  FROM usage.v_call_attributed GROUP BY session_id, activity
)
SELECT
  a.session_id, a.activity, a.turns, a.weighted_tokens,
  CASE WHEN SUM(a.weighted_tokens) OVER w > 0 THEN round(a.weighted_tokens / SUM(a.weighted_tokens) OVER w, 4) ELSE 0 END AS share,
  (a.weighted_tokens = MAX(a.weighted_tokens) OVER w) AS dominant
FROM a
WINDOW w AS (PARTITION BY a.session_id);

-- Per session × feature: what the session contributed to that feature (`sessions --feature`, `--spec`).
CREATE OR REPLACE VIEW usage.v_session_feature_totals AS
SELECT
  c.session_id, c.feature_id, f.spec_number, f.branch,
  COUNT(DISTINCT c.turn_seq)::bigint AS turns,
  SUM(c.input_tokens)::bigint AS input_tokens, SUM(c.output_tokens)::bigint AS output_tokens,
  SUM(c.cache_read_tokens)::bigint AS cache_read_tokens, SUM(c.cache_write_5m_tokens)::bigint AS cache_write_5m_tokens,
  SUM(c.cache_write_1h_tokens)::bigint AS cache_write_1h_tokens, SUM(c.weighted_tokens)::numeric AS weighted_tokens
FROM usage.v_call_attributed c
JOIN usage.features f ON f.feature_id = c.feature_id
GROUP BY c.session_id, c.feature_id, f.spec_number, f.branch;

CREATE OR REPLACE VIEW usage.v_feature_totals AS
WITH calls AS (
  SELECT * FROM usage.v_call_attributed WHERE feature_id IS NOT NULL
), sums AS (
  SELECT feature_id,
    SUM(input_tokens)::bigint AS input_tokens, SUM(output_tokens)::bigint AS output_tokens,
    SUM(cache_read_tokens)::bigint AS cache_read_tokens, SUM(cache_write_5m_tokens)::bigint AS cache_write_5m_tokens,
    SUM(cache_write_1h_tokens)::bigint AS cache_write_1h_tokens,
    COALESCE(SUM(total_tokens) FILTER (WHERE agent_id IS NULL), 0)::bigint AS main_tokens,
    COALESCE(SUM(total_tokens) FILTER (WHERE agent_id IS NOT NULL), 0)::bigint AS subagent_tokens,
    SUM(weighted_tokens)::numeric AS weighted_tokens
  FROM calls GROUP BY feature_id
), turn_n AS (
  SELECT feature_id, COUNT(*)::bigint AS turns, COUNT(DISTINCT session_id)::bigint AS sessions,
    array_agg(DISTINCT session_id) AS session_ids
  FROM usage.turns WHERE feature_id IS NOT NULL GROUP BY feature_id
), mix AS (
  SELECT feature_id, jsonb_object_agg(activity, share) AS activity_mix FROM (
    SELECT feature_id, activity,
      CASE WHEN SUM(SUM(weighted_tokens)) OVER (PARTITION BY feature_id) > 0
           THEN round(SUM(weighted_tokens) / SUM(SUM(weighted_tokens)) OVER (PARTITION BY feature_id), 4) ELSE 0 END AS share
    FROM calls GROUP BY feature_id, activity) m
  GROUP BY feature_id
)
SELECT
  f.feature_id, f.branch, f.first_seen_at, f.kind, f.spec_dir, f.spec_number, f.pr_number, f.pr_state, f.merged_at,
  f.commits, f.lines_added, f.lines_removed, f.tasks_total, f.tasks_done,
  f.ci_runs_red, f.ci_runs_green, f.first_red_at, f.backlog_closed, f.collected_at,
  COALESCE(n.sessions, 0) AS sessions, COALESCE(n.session_ids, '{}') AS session_ids, COALESCE(n.turns, 0) AS turns,
  COALESCE(s.input_tokens, 0) AS input_tokens, COALESCE(s.output_tokens, 0) AS output_tokens,
  COALESCE(s.cache_read_tokens, 0) AS cache_read_tokens, COALESCE(s.cache_write_5m_tokens, 0) AS cache_write_5m_tokens,
  COALESCE(s.cache_write_1h_tokens, 0) AS cache_write_1h_tokens,
  COALESCE(s.main_tokens, 0) AS main_tokens, COALESCE(s.subagent_tokens, 0) AS subagent_tokens,
  COALESCE(s.weighted_tokens, 0) AS weighted_tokens,
  COALESCE(m.activity_mix, '{}'::jsonb) AS activity_mix
FROM usage.features f
LEFT JOIN sums s ON s.feature_id = f.feature_id
LEFT JOIN turn_n n ON n.feature_id = f.feature_id
LEFT JOIN mix m ON m.feature_id = f.feature_id;

CREATE OR REPLACE VIEW usage.v_no_feature_totals AS
SELECT
  COUNT(DISTINCT c.session_id)::bigint AS sessions,
  (SELECT COUNT(*) FROM usage.turns WHERE feature_id IS NULL)::bigint AS turns,
  COALESCE(SUM(c.input_tokens), 0)::bigint AS input_tokens, COALESCE(SUM(c.output_tokens), 0)::bigint AS output_tokens,
  COALESCE(SUM(c.cache_read_tokens), 0)::bigint AS cache_read_tokens, COALESCE(SUM(c.cache_write_5m_tokens), 0)::bigint AS cache_write_5m_tokens,
  COALESCE(SUM(c.cache_write_1h_tokens), 0)::bigint AS cache_write_1h_tokens,
  COALESCE(SUM(c.total_tokens) FILTER (WHERE c.agent_id IS NULL), 0)::bigint AS main_tokens,
  COALESCE(SUM(c.total_tokens) FILTER (WHERE c.agent_id IS NOT NULL), 0)::bigint AS subagent_tokens,
  COALESCE(SUM(c.weighted_tokens), 0)::numeric AS weighted_tokens
FROM usage.v_call_attributed c
WHERE c.feature_id IS NULL;

-- Like-with-like (FR-039): per kind, weighted tokens per merged PR (every feature), per task done (ONLY
-- features with a task list), and the rework share (tokens after the first red CI run).
CREATE OR REPLACE VIEW usage.v_feature_efficiency AS
WITH per AS (
  SELECT f.feature_id, f.kind, f.pr_state, f.tasks_total, f.tasks_done,
    COALESCE(SUM(c.weighted_tokens), 0)::numeric AS weighted,
    COALESCE(SUM(c.weighted_tokens) FILTER (WHERE f.first_red_at IS NOT NULL AND c.ts >= f.first_red_at), 0)::numeric AS rework
  FROM usage.features f
  LEFT JOIN usage.v_call_attributed c ON c.feature_id = f.feature_id
  GROUP BY f.feature_id
)
SELECT
  kind,
  COUNT(*)::bigint AS features,
  COUNT(*) FILTER (WHERE pr_state = 'merged')::bigint AS merged_prs,
  SUM(weighted)::numeric AS weighted_tokens,
  CASE WHEN COUNT(*) FILTER (WHERE pr_state = 'merged') > 0
       THEN round(SUM(weighted) FILTER (WHERE pr_state = 'merged') / COUNT(*) FILTER (WHERE pr_state = 'merged'), 2) END AS weighted_per_merged_pr,
  CASE WHEN SUM(tasks_done) FILTER (WHERE tasks_total IS NOT NULL) > 0
       THEN round(SUM(weighted) FILTER (WHERE tasks_total IS NOT NULL) / SUM(tasks_done) FILTER (WHERE tasks_total IS NOT NULL), 2) END AS weighted_per_task_done,
  CASE WHEN SUM(weighted) > 0 THEN round(SUM(rework) / SUM(weighted), 4) ELSE 0 END AS rework_share
FROM per
GROUP BY kind;

-- Week × activity × area × feature × spec, for Grafana and `trend --by activity|spec`. A turn that
-- touched several areas is SPLIT evenly across them (tokens and `turns` × 1/n), so summing over any
-- dimension gives exact totals; `area_turns` counts every turn that touched the area, for per-area views.
CREATE OR REPLACE VIEW usage.v_weekly_trend AS
SELECT
  date_trunc('week', t.started_at)::date AS week,
  t.activity, a.area, t.feature_id, f.spec_number,
  SUM(a.share)::numeric AS turns,
  COUNT(*)::bigint AS area_turns,
  SUM(t.input_tokens * a.share)::numeric AS input_tokens, SUM(t.output_tokens * a.share)::numeric AS output_tokens,
  SUM(t.cache_read_tokens * a.share)::numeric AS cache_read_tokens, SUM(t.cache_write_5m_tokens * a.share)::numeric AS cache_write_5m_tokens,
  SUM(t.cache_write_1h_tokens * a.share)::numeric AS cache_write_1h_tokens, SUM(t.weighted_tokens * a.share)::numeric AS weighted_tokens
FROM usage.v_turn_totals t
CROSS JOIN LATERAL (
  SELECT x.area, 1.0 / GREATEST(cardinality(t.areas), 1) AS share
  FROM unnest(CASE WHEN cardinality(t.areas) > 0 THEN t.areas ELSE ARRAY['(none)'] END) AS x(area)
) a
LEFT JOIN usage.features f ON f.feature_id = t.feature_id
WHERE t.started_at IS NOT NULL
GROUP BY 1, 2, 3, 4, 5;

GRANT SELECT ON usage.v_call_attributed, usage.v_session_activity_mix, usage.v_session_feature_totals,
  usage.v_feature_totals, usage.v_no_feature_totals, usage.v_feature_efficiency, usage.v_weekly_trend
  TO usage_writer, usage_reader;
