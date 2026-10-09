-- 03_grants.sql: least-privilege grants for the runtime IAM service account
-- user. Run as the admin after 02_schema_v2.sql, with
--   -v runtime_user="yapa-service@<PROJECT_ID>.iam"
-- (Terraform output runtime_db_user). Idempotent.
--
-- The runtime gets DML on documents and only what the design allows on the
-- other tables (section 6): audit_log is append-only for it, users is
-- read-only (an admin job owns the mapping), deletions is append-only.
-- No TRUNCATE, REFERENCES, TRIGGER or DDL anywhere.

\set ON_ERROR_STOP on

\if :{?runtime_user}
\else
  DO $$ BEGIN RAISE EXCEPTION 'pass -v runtime_user=<sa-name>@<project>.iam'; END $$;
\endif

GRANT CONNECT ON DATABASE :"DBNAME" TO :"runtime_user";
GRANT USAGE ON SCHEMA public TO :"runtime_user";

-- Start from nothing, then grant exactly what the service needs.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"runtime_user";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"runtime_user";

GRANT SELECT, INSERT, UPDATE, DELETE ON documents        TO :"runtime_user";
GRANT SELECT, INSERT                 ON deletions        TO :"runtime_user";
GRANT SELECT, INSERT                 ON audit_log        TO :"runtime_user";
GRANT USAGE                          ON SEQUENCE audit_log_seq_seq TO :"runtime_user";
GRANT SELECT                         ON users            TO :"runtime_user";
-- Self-service sign-up (YAPA_AUTO_PROVISION): new rows only; active/disabled
-- stay admin-controlled (no UPDATE).
GRANT INSERT (username, email)       ON users            TO :"runtime_user";
GRANT SELECT, INSERT, DELETE         ON idempotency_keys TO :"runtime_user";
GRANT SELECT                         ON schema_version   TO :"runtime_user";

-- statement_timeout 5 s (design section 7, D). Best effort: Cloud SQL may not
-- let the admin alter an IAM role; the service also sets it per connection.
SELECT set_config('yapa.runtime_user', :'runtime_user', false);
DO $$
BEGIN
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L',
                 current_setting('yapa.runtime_user'), '5s');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'could not set statement_timeout on the runtime role; set it in the service connection options';
END
$$;

-- Show the result; TRUNCATE must be false everywhere.
SELECT c.relname AS object,
       has_table_privilege(:'runtime_user', c.oid, 'SELECT')   AS sel,
       has_table_privilege(:'runtime_user', c.oid, 'INSERT')   AS ins,
       has_table_privilege(:'runtime_user', c.oid, 'UPDATE')   AS upd,
       has_table_privilege(:'runtime_user', c.oid, 'DELETE')   AS del,
       has_table_privilege(:'runtime_user', c.oid, 'TRUNCATE') AS trunc
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY 1;
