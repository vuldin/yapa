-- 02_schema_v2.sql: schema v2 from docs/service-design.md section 6.
-- Run as the admin after 01_schema_v1.sql. Idempotent (IF NOT EXISTS
-- everywhere), so it is also safe on a v1 database that already has data,
-- provided the pre-checks pass.
--
-- Differences from the design text, on purpose:
--   * The design says rows with a non-384 embedding are re-embedded by the
--     migration job. Re-embedding is out of scope for josh-310: this file
--     refuses to run while such rows exist, and scripts/migrate-db.mjs
--     reports and skips them instead of copying them.
--   * IF NOT EXISTS / USING clauses added so the file can be re-run.

\set ON_ERROR_STOP on
SET ROLE yapa_owner;

-- Pre-checks: every embedding is 384-d, and no local-only rows exist
-- (global, private-*, local-*; decision 6).
DO $$
DECLARE
  bad_dims   bigint;
  local_only bigint;
BEGIN
  SELECT count(*) INTO bad_dims FROM documents WHERE vector_dims(embedding) <> 384;
  IF bad_dims > 0 THEN
    RAISE EXCEPTION 'v2 pre-check: % row(s) have embeddings that are not 384-dimensional; re-embed or remove them first', bad_dims;
  END IF;

  SELECT count(*) INTO local_only FROM documents
   WHERE collection = 'global' OR collection LIKE 'private-%' OR collection LIKE 'local-%';
  IF local_only > 0 THEN
    RAISE EXCEPTION 'v2 pre-check: % local-only row(s) (global, private-*, local-*) must be removed first', local_only;
  END IF;
END
$$;

-- users: identity mapping (email -> username)
CREATE TABLE IF NOT EXISTS users (
  username     TEXT PRIMARY KEY CHECK (username ~ '^[A-Za-z0-9_-]{1,64}$'),
  email        TEXT NOT NULL UNIQUE,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at  TIMESTAMPTZ
);

-- documents: keep v1 columns, add attribution, fix the embedding dimension
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS last_editor TEXT,
  ADD COLUMN IF NOT EXISTS last_device TEXT,
  ALTER COLUMN embedding TYPE vector(384) USING embedding::vector(384);

CREATE INDEX IF NOT EXISTS idx_docs_coll_synced ON documents (collection, synced_at, id);
CREATE INDEX IF NOT EXISTS idx_docs_embedding ON documents USING hnsw (embedding vector_cosine_ops);
DROP INDEX IF EXISTS idx_docs_synced_at;  -- superseded by the composite

-- deletions: feed that lets teammates' clients drop deleted rows (decision 5)
CREATE TABLE IF NOT EXISTS deletions (
  id TEXT NOT NULL,
  collection TEXT NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, deleted_at)
);
CREATE INDEX IF NOT EXISTS idx_deletions_coll_at ON deletions (collection, deleted_at, id);

-- audit_log: append-only record of every write
CREATE TABLE IF NOT EXISTS audit_log (
  seq             BIGSERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor           TEXT NOT NULL,          -- username
  actor_email     TEXT NOT NULL,
  device          TEXT,
  request_id      TEXT NOT NULL,
  action          TEXT NOT NULL,          -- insert|update|archive|move|delete|link|retract
                                          -- |overwrote_teammate_edit|transfer_owner
  doc_id          TEXT NOT NULL,
  collection      TEXT NOT NULL,
  prev_collection TEXT,
  prev_editor     TEXT,                   -- last writer before this write
  row_owner       TEXT NOT NULL,
  change_class    TEXT NOT NULL,          -- own|teammate (teammate = ADP candidate)
  content_sha256  TEXT,                   -- hash, not content
  changed_keys    TEXT[]                  -- metadata keys that changed
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  response   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_version (version) VALUES (2) ON CONFLICT (version) DO NOTHING;

RESET ROLE;
