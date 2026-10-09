/**
 * Database access. Production: Cloud SQL Node connector, IAM database auth,
 * private IP (no password exists). Local dev and tests: YAPA_DATABASE_URL.
 * Every connection gets a 5 s statement_timeout; every transaction sets the
 * caller with set_config('yapa.user', ..., true) so 04_rls.sql applies.
 */
import pg from 'pg';
import type { ServiceConfig } from './config.js';

export interface Db {
  pool: pg.Pool;
  close(): Promise<void>;
}

export async function createDb(cfg: ServiceConfig): Promise<Db> {
  const common: pg.PoolConfig = {
    max: cfg.poolMax,
    statement_timeout: cfg.statementTimeoutMs,
    idle_in_transaction_session_timeout: cfg.statementTimeoutMs * 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 60_000,
    application_name: 'yapa-service',
  };

  if (cfg.databaseUrl) {
    const pool = new pg.Pool({ ...common, connectionString: cfg.databaseUrl });
    return { pool, close: () => pool.end() };
  }

  const { Connector, IpAddressTypes, AuthTypes } = await import('@google-cloud/cloud-sql-connector');
  const connector = new Connector();
  const ipType = cfg.dbIpType === 'PUBLIC' ? IpAddressTypes.PUBLIC : cfg.dbIpType === 'PSC' ? IpAddressTypes.PSC : IpAddressTypes.PRIVATE;
  const clientOpts = await connector.getOptions({
    instanceConnectionName: cfg.instanceConnectionName!,
    ipType,
    authType: AuthTypes.IAM,
  });
  const pool = new pg.Pool({ ...common, ...clientOpts, user: cfg.dbUser, database: cfg.dbName });
  return {
    pool,
    close: async () => {
      await pool.end();
      connector.close();
    },
  };
}

/** Run `fn` in a transaction with the caller set for RLS. */
export async function withUserTx<T>(pool: pg.Pool, username: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('yapa.user', $1, true)", [username]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** True for errors that mean "database unavailable/overloaded" (-> 503). */
export function isUnavailableError(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  if (!err) return false;
  if (err.code && /^(57014|57P0[1-3]|53\d{3}|08\d{3}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH)$/.test(err.code)) return true;
  return /timeout exceeded when trying to connect|Connection terminated|connect ECONNREFUSED/i.test(err.message ?? '');
}
