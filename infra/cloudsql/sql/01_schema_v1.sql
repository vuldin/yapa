-- 01_schema_v1.sql: the v1 schema exactly as packages/core/src/sync/schema.ts
-- creates it (minus the lazy ivfflat index, which never worked on an untyped
-- vector column; v2 adds an HNSW index instead). Owned by yapa_owner.
-- Idempotent. Run as the admin after 00_roles.sql.

\set ON_ERROR_STOP on
SET ROLE yapa_owner;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  origin_user TEXT NOT NULL,
  related_ids TEXT[] DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docs_collection ON documents(collection);
CREATE INDEX IF NOT EXISTS idx_docs_synced_at ON documents(synced_at);
CREATE INDEX IF NOT EXISTS idx_docs_origin_user ON documents(origin_user);

INSERT INTO schema_version (version) VALUES (1) ON CONFLICT (version) DO NOTHING;

RESET ROLE;
