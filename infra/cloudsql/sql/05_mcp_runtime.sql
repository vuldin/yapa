-- 05_mcp_runtime.sql: grants and RLS for the remote MCP service (yapa-mcp,
-- josh-313) IAM user. Run as the admin after 04_rls.sql, with
--   -v mcp_user="yapa-mcp@<PROJECT_ID>.iam"
-- (Terraform output mcp_runtime_db_user). Idempotent.
--
-- Phase 1 of yapa-mcp is read-only: SELECT on what the tools read, nothing
-- else, except INSERT (username, email) on users for self-service sign-up
-- (YAPA_AUTO_PROVISION), the same column grant the sync service has.
-- 04_rls.sql policies are `TO runtime_user` only, so without the policy below
-- this role would see no documents at all (RLS default deny).

\set ON_ERROR_STOP on

\if :{?mcp_user}
\else
  DO $$ BEGIN RAISE EXCEPTION 'pass -v mcp_user=<sa-name>@<project>.iam'; END $$;
\endif

GRANT CONNECT ON DATABASE :"DBNAME" TO :"mcp_user";
GRANT USAGE ON SCHEMA public TO :"mcp_user";

-- Start from nothing, then grant exactly what the read tools need.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"mcp_user";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"mcp_user";

GRANT SELECT                         ON documents        TO :"mcp_user";
GRANT SELECT                         ON deletions        TO :"mcp_user";
GRANT SELECT                         ON users            TO :"mcp_user";
GRANT INSERT (username, email)       ON users            TO :"mcp_user";
GRANT SELECT                         ON schema_version   TO :"mcp_user";

-- Same read rule as docs_select in 04_rls.sql; there are no insert/update/
-- delete policies for this role, so writes would be denied even with grants.
SET ROLE yapa_owner;
DROP POLICY IF EXISTS docs_select_mcp ON documents;
CREATE POLICY docs_select_mcp ON documents FOR SELECT TO :"mcp_user"
  USING (collection <> 'global' AND collection NOT LIKE 'private-%' AND collection NOT LIKE 'local-%');
RESET ROLE;

-- statement_timeout 5 s, best effort (see 03_grants.sql).
SELECT set_config('yapa.mcp_user', :'mcp_user', false);
DO $$
BEGIN
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L',
                 current_setting('yapa.mcp_user'), '5s');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'could not set statement_timeout on the mcp role; the service also sets it per connection';
END
$$;

-- Show the result; only sel may be true (the users column grant shows in \dp users).
SELECT c.relname AS object,
       has_table_privilege(:'mcp_user', c.oid, 'SELECT')   AS sel,
       has_table_privilege(:'mcp_user', c.oid, 'INSERT')   AS ins,
       has_table_privilege(:'mcp_user', c.oid, 'UPDATE')   AS upd,
       has_table_privilege(:'mcp_user', c.oid, 'DELETE')   AS del,
       has_table_privilege(:'mcp_user', c.oid, 'TRUNCATE') AS trunc
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY 1;
