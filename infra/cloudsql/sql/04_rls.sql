-- 04_rls.sql: row-level security as defense in depth (design section 6).
-- Apply together with the first josh-311 service release, which must run
-- `SELECT set_config('yapa.user', $1, true)` (SET LOCAL yapa.user fails: `user` is reserved) in every transaction. Before that it is
-- harmless (no runtime traffic yet). The admin bypasses RLS as a member of the
-- table owner, so migrations and restores are unaffected.
-- Run as the admin with -v runtime_user=... Idempotent.

\set ON_ERROR_STOP on
SET ROLE yapa_owner;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS docs_select ON documents;
DROP POLICY IF EXISTS docs_insert ON documents;
DROP POLICY IF EXISTS docs_update ON documents;
DROP POLICY IF EXISTS docs_delete ON documents;

-- Shared rows are readable by every active member (no per-collection ACLs in
-- v1, decision 7); local-only collections never qualify.
CREATE POLICY docs_select ON documents FOR SELECT TO :"runtime_user"
  USING (collection <> 'global' AND collection NOT LIKE 'private-%' AND collection NOT LIKE 'local-%');

-- Inserts are attributed to the caller.
CREATE POLICY docs_insert ON documents FOR INSERT TO :"runtime_user"
  WITH CHECK (origin_user = current_setting('yapa.user', true)
              AND collection <> 'global' AND collection NOT LIKE 'private-%' AND collection NOT LIKE 'local-%');

-- Teammate edits are allowed (ADP-reviewed later); immutability of
-- origin_user/created_at is enforced by the service.
CREATE POLICY docs_update ON documents FOR UPDATE TO :"runtime_user"
  -- On a pooled connection the setting reverts to '' (not NULL) after commit.
  USING (NULLIF(current_setting('yapa.user', true), '') IS NOT NULL)
  WITH CHECK (collection <> 'global' AND collection NOT LIKE 'private-%' AND collection NOT LIKE 'local-%');

-- Owner-only delete.
CREATE POLICY docs_delete ON documents FOR DELETE TO :"runtime_user"
  USING (origin_user = current_setting('yapa.user', true));

-- Authorship is immutable for everyone, even the table owner, unless an
-- admin ownership transfer (design decision 10) opts in for its transaction:
--   SELECT set_config('yapa.allow_owner_change', 'on', true);
CREATE OR REPLACE FUNCTION yapa_guard_authorship() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.origin_user IS DISTINCT FROM OLD.origin_user OR NEW.created_at IS DISTINCT FROM OLD.created_at)
     AND COALESCE(current_setting('yapa.allow_owner_change', true), '') <> 'on' THEN
    RAISE EXCEPTION 'origin_user and created_at are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS documents_guard_authorship ON documents;
CREATE TRIGGER documents_guard_authorship BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION yapa_guard_authorship();

RESET ROLE;
