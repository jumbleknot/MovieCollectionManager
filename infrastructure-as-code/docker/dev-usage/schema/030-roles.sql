-- Feature 105 roles (FR-014; research R10, R18). Idempotent: roles are created only when absent and
-- their passwords re-set on every apply, from psql variables the dev-usage-schema-init service passes:
--   -v authenticator_password=… -v reader_password=…
--
--   authenticator  PostgREST's login; NOINHERIT, can only SET ROLE to usage_writer.
--   usage_writer   the role a valid Keycloak token's `role` claim selects: INSERT, UPDATE, SELECT on
--                  the tables, SELECT on the views. NO DELETE, NO TRUNCATE, NO DDL.
--   usage_reader   Grafana's login (US3): SELECT on the views only.
-- There is NO anonymous role: PostgREST rejects a request without a valid token.

SELECT 'CREATE ROLE authenticator LOGIN NOINHERIT'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') \gexec
SELECT 'CREATE ROLE usage_writer NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usage_writer') \gexec
SELECT 'CREATE ROLE usage_reader LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usage_reader') \gexec

ALTER ROLE authenticator WITH LOGIN NOINHERIT PASSWORD :'authenticator_password';
ALTER ROLE usage_reader WITH LOGIN PASSWORD :'reader_password';
GRANT usage_writer TO authenticator;

GRANT USAGE ON SCHEMA usage TO usage_writer, usage_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA usage FROM PUBLIC;
REVOKE CREATE ON SCHEMA usage FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON
  usage.sessions, usage.model_calls, usage.turns, usage.tool_use, usage.skill_use
  TO usage_writer;
REVOKE DELETE, TRUNCATE ON
  usage.sessions, usage.model_calls, usage.turns, usage.tool_use, usage.skill_use
  FROM usage_writer;
