-- 06_coordination.sql: schema v3, multi-session coordination (josh-631).
-- Leases with a scope and a TTL, and atomic counters.
-- Run as the admin after 05 (or after 04 where yapa-mcp is not deployed),
-- with -v runtime_user="yapa-service@<PROJECT_ID>.iam". Idempotent.
--
-- 03_grants.sql starts with REVOKE ALL ON ALL TABLES, so re-run this file
-- after any re-run of 03.
--
-- No RLS here: these tables hold no document content, only coordination
-- state for shared collections, and the service enforces who may renew or
-- release a lease (its holder) and which collections qualify (shared ones).

\set ON_ERROR_STOP on

\if :{?runtime_user}
\else
  DO $$ BEGIN RAISE EXCEPTION 'pass -v runtime_user=<sa-name>@<project>.iam'; END $$;
\endif

SET ROLE yapa_owner;

-- leases: one row per (collection, key). A row whose expires_at has passed is
-- expired: any member may take it over, and the takeover is recorded.
CREATE TABLE IF NOT EXISTS leases (
  collection      TEXT NOT NULL,
  key             TEXT NOT NULL,
  holder_user     TEXT NOT NULL,
  holder_device   TEXT,
  holder_session  TEXT NOT NULL,
  title           TEXT,
  scope           TEXT[] NOT NULL,
  ttl_seconds     INTEGER NOT NULL CHECK (ttl_seconds > 0),
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  took_over_from  JSONB,            -- {user, session, device, expired_at} of the previous holder
  PRIMARY KEY (collection, key)
);
CREATE INDEX IF NOT EXISTS idx_leases_scope ON leases USING gin (scope);
CREATE INDEX IF NOT EXISTS idx_leases_holder ON leases (collection, holder_user, holder_session);

-- lease_log: append-only history (acquire, renew, takeover, release, refuse).
CREATE TABLE IF NOT EXISTS lease_log (
  seq             BIGSERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  collection      TEXT NOT NULL,
  key             TEXT NOT NULL,
  action          TEXT NOT NULL,    -- acquire|reacquire|takeover|release|refused
  actor           TEXT NOT NULL,
  device          TEXT,
  session         TEXT NOT NULL,
  request_id      TEXT NOT NULL,
  detail          JSONB             -- outcome, previous holder, conflicting keys
);
CREATE INDEX IF NOT EXISTS idx_lease_log_key ON lease_log (collection, key, seq);

-- counters: monotonic per (collection, name). Task ids use the reserved
-- collection '@tasks' with name = username (one sequence per user).
CREATE TABLE IF NOT EXISTS counters (
  collection  TEXT NOT NULL,
  name        TEXT NOT NULL,
  value       BIGINT NOT NULL CHECK (value >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (collection, name)
);

INSERT INTO schema_version (version) VALUES (3) ON CONFLICT (version) DO NOTHING;

RESET ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON leases    TO :"runtime_user";
GRANT SELECT, INSERT                 ON lease_log TO :"runtime_user";
GRANT USAGE                          ON SEQUENCE lease_log_seq_seq TO :"runtime_user";
GRANT SELECT, INSERT, UPDATE         ON counters  TO :"runtime_user";
