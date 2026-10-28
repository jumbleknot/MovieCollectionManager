-- Keep Komodo's pg_cron run history to 3 days (spec 084 FR-019d, research R8).
--
-- pg_cron logs every job run into cron.job_run_details and nothing purged it: 11.9 M rows and
-- 2,147 MB by 2026-10-27, about 89,000 rows a day from DocumentDB's own jobs (two run every 2 s).
-- The nightly backup already excludes the table's rows; this stops the table itself growing.
--
-- Applied by hand, and safe to apply again (README): the job is removed if it exists, then created.
-- pg_cron lives in the `postgres` database here (`SHOW cron.database_name`, 2026-10-28):
--   docker exec -i -e PGPASSWORD komodo-postgres-1 psql -U "$KU" -d postgres -v ON_ERROR_STOP=1 < komodo-cron-retention.sql

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-cron-run-history';

SELECT cron.schedule(
  'purge-cron-run-history',
  '17 * * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '3 days'$$
);
