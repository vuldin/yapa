/**
 * Integration-test database: a fresh database on the server named by
 * YAPA_SERVICE_IT_DATABASE_URL (a superuser URL, e.g. a throwaway
 * pgvector/pgvector:pg17 container), with the production schema applied
 * from infra/cloudsql/sql/00-04 and a non-owner runtime login so the RLS
 * policies in 04_rls.sql are really in force.
 *
 * The SQL files are psql scripts; the few psql meta-commands they use are
 * translated here (\set lines dropped, \if blocks removed, :"var" and :'var'
 * substituted). The pgaudit extension line is skipped (not in the image).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../infra/cloudsql/sql');
const FILES = ['00_roles.sql', '01_schema_v1.sql', '02_schema_v2.sql', '03_grants.sql', '04_rls.sql'];
export const RUNTIME_ROLE = 'yapa_it_runtime';

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function translatePsql(sql: string, vars: Record<string, string>): string {
  const out: string[] = [];
  let skipping = 0;
  for (const line of sql.split('\n')) {
    const t = line.trim();
    if (t.startsWith('\\if')) { skipping++; continue; }
    if (t.startsWith('\\endif')) { skipping--; continue; }
    if (skipping > 0) continue;
    if (t.startsWith('\\')) continue;
    if (/CREATE EXTENSION IF NOT EXISTS pgaudit/i.test(t)) continue;
    out.push(line);
  }
  return out.join('\n')
    .replace(/:"([A-Za-z_]+)"/g, (_, v) => ident(need(vars, v)))
    .replace(/:'([A-Za-z_]+)'/g, (_, v) => literal(need(vars, v)));
}

function need(vars: Record<string, string>, v: string): string {
  if (!(v in vars)) throw new Error(`psql variable ${v} not provided`);
  return vars[v];
}

export interface ItDb {
  adminPool: pg.Pool;
  runtimeUrl: string;
  dbName: string;
  drop(): Promise<void>;
}

export async function createItDb(adminUrl: string): Promise<ItDb> {
  const dbName = `yapa_it_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${ident(dbName)}`);
  await root.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN CREATE ROLE ${RUNTIME_ROLE} LOGIN; END IF;
    END $$`);
  await root.query(`ALTER ROLE ${RUNTIME_ROLE} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${literal(password)}`);
  await root.end();

  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = `/${dbName}`;
  const admin = new pg.Client({ connectionString: dbUrl.toString() });
  await admin.connect();
  const vars = { DBNAME: dbName, runtime_user: RUNTIME_ROLE };
  for (const f of FILES) {
    await admin.query(translatePsql(readFileSync(join(SQL_DIR, f), 'utf8'), vars));
  }
  await admin.end();

  const runtime = new URL(dbUrl.toString());
  runtime.username = RUNTIME_ROLE;
  runtime.password = password;

  const adminPool = new pg.Pool({ connectionString: dbUrl.toString(), max: 2 });
  return {
    adminPool,
    runtimeUrl: runtime.toString(),
    dbName,
    async drop() {
      await adminPool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${ident(dbName)} WITH (FORCE)`);
      await c.end();
    },
  };
}
