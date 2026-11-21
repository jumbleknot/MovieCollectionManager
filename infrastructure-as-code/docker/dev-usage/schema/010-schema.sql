-- Feature 105 — Claude Code token usage store. Applied in name order on EVERY deploy by the run-once
-- `dev-usage-schema-init` service (research R19), so every statement here must be idempotent.
CREATE SCHEMA IF NOT EXISTS usage;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'usage' AND t.typname = 'capture_status') THEN
    CREATE TYPE usage.capture_status AS ENUM ('complete', 'partial', 'not_captured');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'usage' AND t.typname = 'turn_origin') THEN
    CREATE TYPE usage.turn_origin AS ENUM ('human', 'task_notification', 'other');
  END IF;
END
$$;
