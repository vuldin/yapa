import { getPool } from './postgres.js';

const CURRENT_VERSION = 1;

const SCHEMA_V1 = `
CREATE EXTENSION IF NOT EXISTS vector;

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
`;

// ivfflat index requires data to exist first; we create it lazily
const IVFFLAT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_docs_embedding ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
`;

/**
 * Auto-migrate the remote database schema.
 * Creates tables if they don't exist, runs migrations if version is behind.
 */
export async function migrateSchema(): Promise<void> {
  const pool = getPool();

  // Check if schema_version table exists
  const tableCheck = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = 'schema_version'
    ) AS exists
  `);

  if (!tableCheck.rows[0].exists) {
    // Fresh install — run full schema
    process.stderr.write('[yapa-sync] Creating remote schema (v1)...\n');
    await pool.query(SCHEMA_V1);
    await pool.query('INSERT INTO schema_version (version) VALUES ($1)', [CURRENT_VERSION]);
    process.stderr.write('[yapa-sync] Remote schema created.\n');
    return;
  }

  // Check current version
  const versionResult = await pool.query('SELECT MAX(version) AS version FROM schema_version');
  const currentVersion = versionResult.rows[0]?.version ?? 0;

  if (currentVersion >= CURRENT_VERSION) {
    return; // Up to date
  }

  // Future migrations would go here:
  // if (currentVersion < 2) { await runMigrationV2(pool); }

  process.stderr.write(`[yapa-sync] Schema is at v${currentVersion}, current is v${CURRENT_VERSION}.\n`);
}

/**
 * Try to create the ivfflat index for faster similarity search.
 * This requires some data to already exist in the table.
 * Safe to call multiple times — uses IF NOT EXISTS.
 */
export async function ensureVectorIndex(): Promise<void> {
  try {
    const pool = getPool();
    const countResult = await pool.query('SELECT COUNT(*) AS cnt FROM documents');
    const count = parseInt(countResult.rows[0].cnt, 10);
    if (count >= 100) {
      await pool.query(IVFFLAT_INDEX);
    }
  } catch {
    // Index creation can fail if not enough data — that's fine
  }
}
