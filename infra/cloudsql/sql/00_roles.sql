-- 00_roles.sql: run once as the built-in admin (var.admin_username), on the
-- `yapa` database of the new instance. Idempotent.
--
--   yapa_owner   NOLOGIN, owns every YAPA table/index/sequence (DDL rights).
--   admin        member of yapa_owner; runs migrations with SET ROLE.
--   runtime      the IAM service account user (see 03_grants.sql): DML only.

\set ON_ERROR_STOP on

-- Extensions need cloudsqlsuperuser, which the built-in admin has.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgaudit;  -- instance flags enable it; pgaudit.log = write,ddl

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yapa_owner') THEN
    CREATE ROLE yapa_owner NOLOGIN;
  END IF;
END
$$;

-- Lets the admin SET ROLE yapa_owner (and act with its privileges).
GRANT yapa_owner TO CURRENT_USER;

-- Nobody gets access by default; grants below and in 03_grants.sql are explicit.
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"DBNAME" TO CURRENT_USER;
GRANT CONNECT ON DATABASE :"DBNAME" TO yapa_owner;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO yapa_owner;
GRANT USAGE ON SCHEMA public TO CURRENT_USER;
