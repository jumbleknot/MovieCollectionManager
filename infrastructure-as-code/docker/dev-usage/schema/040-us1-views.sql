-- Feature 105 US1 views (data-model.md "Views"). CREATE OR REPLACE, so a re-apply is a no-op and a
-- later story can extend them. Read by the skill (US2) and Grafana (US3); usage_reader sees only views.

CREATE OR REPLACE VIEW usage.v_session_totals AS
SELECT
  s.session_id,
  s.project_dir,
  s.starting_worktree,
  s.starting_branch,
  s.entrypoint,
  s.started_at,
  s.ended_at,
  s.end_reason,
  s.capture_status,
  s.partial_reasons,
  s.compactions,
  s.manual_tag,
  COALESCE(SUM(c.input_tokens), 0)::bigint AS input_tokens,
  COALESCE(SUM(c.output_tokens), 0)::bigint AS output_tokens,
  COALESCE(SUM(c.cache_read_tokens), 0)::bigint AS cache_read_tokens,
  COALESCE(SUM(c.cache_write_5m_tokens), 0)::bigint AS cache_write_5m_tokens,
  COALESCE(SUM(c.cache_write_1h_tokens), 0)::bigint AS cache_write_1h_tokens,
  COALESCE(SUM(c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_5m_tokens + c.cache_write_1h_tokens)
           FILTER (WHERE c.agent_id IS NULL), 0)::bigint AS main_tokens,
  COALESCE(SUM(c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_5m_tokens + c.cache_write_1h_tokens)
           FILTER (WHERE c.agent_id IS NOT NULL), 0)::bigint AS subagent_tokens,
  COUNT(c.message_id)::bigint AS model_calls,
  (SELECT COUNT(*) FROM usage.turns t WHERE t.session_id = s.session_id)::bigint AS turns,
  (SELECT t.context_tokens_at_start FROM usage.turns t WHERE t.session_id = s.session_id ORDER BY t.turn_seq LIMIT 1) AS floor_tokens,
  -- US2 (`sessions --area`): the union of the turns' areas. LAST, because CREATE OR REPLACE VIEW can
  -- only append columns to a view that already exists on a running store.
  (SELECT COALESCE(array_agg(DISTINCT a ORDER BY a), '{}') FROM usage.turns t, unnest(t.areas) AS a
    WHERE t.session_id = s.session_id) AS areas
FROM usage.sessions s
LEFT JOIN usage.model_calls c ON c.session_id = s.session_id
GROUP BY s.session_id;

CREATE OR REPLACE VIEW usage.v_turn_totals AS
SELECT
  t.session_id,
  t.turn_seq,
  t.origin,
  t.started_at,
  t.ended_at,
  t.idle_gap_s,
  t.context_tokens_at_start,
  t.areas,
  t.rereads,
  COALESCE(SUM(c.input_tokens), 0)::bigint AS input_tokens,
  COALESCE(SUM(c.output_tokens), 0)::bigint AS output_tokens,
  COALESCE(SUM(c.cache_read_tokens), 0)::bigint AS cache_read_tokens,
  COALESCE(SUM(c.cache_write_5m_tokens), 0)::bigint AS cache_write_5m_tokens,
  COALESCE(SUM(c.cache_write_1h_tokens), 0)::bigint AS cache_write_1h_tokens,
  COUNT(c.message_id)::bigint AS model_calls
FROM usage.turns t
LEFT JOIN usage.model_calls c ON c.session_id = t.session_id AND c.turn_seq = t.turn_seq
GROUP BY t.session_id, t.turn_seq;

GRANT SELECT ON usage.v_session_totals, usage.v_turn_totals TO usage_writer, usage_reader;
