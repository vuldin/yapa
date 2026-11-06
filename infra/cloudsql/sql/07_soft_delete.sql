-- 07_soft_delete.sql: schema v4, soft delete, restore and purge.
-- Run as the admin after 06 (or after 04 where 06 is not applied yet), with
-- -v runtime_user="yapa-service@<PROJECT_ID>.iam". Idempotent.
--
-- 03_grants.sql starts with REVOKE ALL ON ALL TABLES, so re-run this file
-- (after 06) after any re-run of 03.
--
--   deleted_documents  a deleted row, kept for YAPA_DELETED_RETENTION_DAYS
--                      (default 30) so its owner can list and restore it.
--                      Owner-only under RLS, like deletes on documents.
--   purged_ids         ids their owner purged for good; upserts of them are
--                      refused (item error `purged`). Readable by every
--                      member for that check.
--   deletions          gains `reason` (delete|retract) and `purged` (the
--                      entry of a purge: clients drop every copy).
--
-- An older service keeps working against this schema: it still DELETEs from
-- documents and INSERTs (id, collection, deleted_by) into deletions, which
-- gets the column defaults (reason 'delete', purged false).

\set ON_ERROR_STOP on

\if :{?runtime_user}
\else
  DO $$ BEGIN RAISE EXCEPTION 'pass -v runtime_user=<sa-name>@<project>.iam'; END $$;
\endif

SET ROLE yapa_owner;

-- deleted_documents: the columns of documents (01 + 02) plus who, when, why.
CREATE TABLE IF NOT EXISTS deleted_documents (
  id           TEXT NOT NULL,
  collection   TEXT NOT NULL,
  content      TEXT NOT NULL,
  embedding    vector(384) NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}',
  origin_user  TEXT NOT NULL,
  related_ids  TEXT[] DEFAULT '{}',
  synced_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  last_editor  TEXT,
  last_device  TEXT,
  deleted_by   TEXT NOT NULL,
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason       TEXT NOT NULL CHECK (reason IN ('delete', 'retract')),
  PRIMARY KEY (id, deleted_at)
);
CREATE INDEX IF NOT EXISTS idx_deleted_docs_owner ON deleted_documents (origin_user, collection, deleted_at);
CREATE INDEX IF NOT EXISTS idx_deleted_docs_at ON deleted_documents (deleted_at);  -- retention sweep

CREATE TABLE IF NOT EXISTS purged_ids (
  id         TEXT PRIMARY KEY,
  purged_by  TEXT NOT NULL,
  purged_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE deletions
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'delete',
  ADD COLUMN IF NOT EXISTS purged BOOLEAN NOT NULL DEFAULT false;

-- Row-level security, same rule as docs_delete in 04_rls.sql: a user sees and
-- changes only their own deleted rows.
ALTER TABLE deleted_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deleted_docs_select ON deleted_documents;
DROP POLICY IF EXISTS deleted_docs_insert ON deleted_documents;
DROP POLICY IF EXISTS deleted_docs_delete ON deleted_documents;
CREATE POLICY deleted_docs_select ON deleted_documents FOR SELECT TO :"runtime_user"
  USING (origin_user = current_setting('yapa.user', true));
CREATE POLICY deleted_docs_insert ON deleted_documents FOR INSERT TO :"runtime_user"
  WITH CHECK (origin_user = current_setting('yapa.user', true)
              AND deleted_by = current_setting('yapa.user', true)
              AND collection <> 'global' AND collection NOT LIKE 'private-%' AND collection NOT LIKE 'local-%');
CREATE POLICY deleted_docs_delete ON deleted_documents FOR DELETE TO :"runtime_user"
  USING (origin_user = current_setting('yapa.user', true));

-- purged_ids: every member reads it (the upsert refusal check); a row names
-- the caller as purger.
ALTER TABLE purged_ids ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purged_ids_select ON purged_ids;
DROP POLICY IF EXISTS purged_ids_insert ON purged_ids;
CREATE POLICY purged_ids_select ON purged_ids FOR SELECT TO :"runtime_user"
  USING (NULLIF(current_setting('yapa.user', true), '') IS NOT NULL);
CREATE POLICY purged_ids_insert ON purged_ids FOR INSERT TO :"runtime_user"
  WITH CHECK (purged_by = current_setting('yapa.user', true));

-- Retention: the service calls this at most every few minutes. It runs as
-- the table owner (bypassing the owner-only RLS above) so expired rows of
-- every user go, not only the caller's; it can only remove rows older than
-- `retention_days` (at least 1).
CREATE OR REPLACE FUNCTION yapa_purge_expired_deleted(retention_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  n integer;
BEGIN
  IF retention_days IS NULL OR retention_days < 1 THEN
    RAISE EXCEPTION 'retention must be at least 1 day' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM deleted_documents WHERE deleted_at < now() - make_interval(days => retention_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;
REVOKE ALL ON FUNCTION yapa_purge_expired_deleted(integer) FROM PUBLIC;

INSERT INTO schema_version (version) VALUES (4) ON CONFLICT (version) DO NOTHING;

RESET ROLE;

GRANT SELECT, INSERT, DELETE ON deleted_documents TO :"runtime_user";
GRANT SELECT, INSERT         ON purged_ids        TO :"runtime_user";
GRANT EXECUTE ON FUNCTION yapa_purge_expired_deleted(integer) TO :"runtime_user";
