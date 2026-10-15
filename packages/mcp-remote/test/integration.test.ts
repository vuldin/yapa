/**
 * End-to-end tests of the read tools against a real Postgres+pgvector with
 * the production schema, grants and RLS, including 05_mcp_runtime.sql for a
 * separate non-owner yapa-mcp login. Reuses the sync service's test-database
 * setup. Skipped unless YAPA_SERVICE_IT_DATABASE_URL is set, e.g.:
 *
 *   docker run -d --rm --name yapa-it -e POSTGRES_PASSWORD=it -p 55432:5432 pgvector/pgvector:pg17
 *   YAPA_SERVICE_IT_DATABASE_URL=postgres://postgres:it@localhost:55432/postgres npm run test:integration -w packages/mcp-remote
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { findUserByEmail, setLogSink } from '@yapa/service/lib';
import { createItDb, translatePsql, type ItDb } from '../../service/test/pgsetup.js';
import { createApp } from '../src/app.js';
import { McpAuthenticator } from '../src/auth.js';
import type { QueryEmbedder } from '../src/embedder.js';

const URL_ = process.env.YAPA_SERVICE_IT_DATABASE_URL;
const SQL_05 = join(dirname(fileURLToPath(import.meta.url)), '../../../infra/cloudsql/sql/05_mcp_runtime.sql');
const MCP_ROLE = 'yapa_it_mcp';
const NOW = Math.floor(Date.now() / 1000);

function unitVector(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * (i + 1)) + 0.01 * seed);
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

/** Queries name a seed ("seed:3") so tests control which rows are nearest. */
const embedder: QueryEmbedder = {
  embed: async (text: string) => unitVector(Number(/seed:(\d+)/.exec(text)?.[1] ?? 1)),
  ready: () => true,
};

describe.skipIf(!URL_)('yapa-mcp integration (real Postgres + RLS)', () => {
  let db: ItDb;
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let restoreLog: () => void;

  const call = async (tool: string, args: Record<string, unknown>, user = 'alice') => {
    const r = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer test:${user}@example.com` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    return { text: body.result.content[0].text as string, isError: body.result.isError === true };
  };

  const insert = async (id: string, collection: string, content: string, seed: number, metadata: Record<string, unknown>, owner = 'alice', editor: string | null = null, updatedAgo = 50) => {
    await db.adminPool.query(
      `INSERT INTO documents (id, collection, content, embedding, metadata, origin_user, last_editor, created_at, updated_at, synced_at)
       VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6, $7, to_timestamp($8), to_timestamp($9), clock_timestamp())`,
      [id, collection, content, `[${unitVector(seed).join(',')}]`, JSON.stringify(metadata), owner, editor, NOW - 1000, NOW - updatedAgo],
    );
  };

  beforeAll(async () => {
    restoreLog = setLogSink(() => undefined);
    db = await createItDb(URL_!);
    const password = randomBytes(12).toString('hex');
    await db.adminPool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MCP_ROLE}') THEN CREATE ROLE ${MCP_ROLE} LOGIN; END IF;
      END $$`);
    await db.adminPool.query(`ALTER ROLE ${MCP_ROLE} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await db.adminPool.query(translatePsql(readFileSync(SQL_05, 'utf8'), { DBNAME: db.dbName, mcp_user: MCP_ROLE }));

    await db.adminPool.query(
      `INSERT INTO users (username, email, active) VALUES ('alice', 'alice@example.com', true), ('bob', 'bob@example.com', true)`,
    );
    await insert('m-1', 'customer-acme', 'acme upgrade went fine', 1, { type: 'memory', salience: 1.0, sector: 'episodic' });
    await insert('m-2', 'customer-acme', 'acme asked about tiered storage', 2, { type: 'memory', salience: 2.0 }, 'bob', 'alice', 10);
    await insert('m-arch', 'customer-acme', 'archived acme fact', 1, { type: 'memory', archived: true, superseded_by: 'm-1' });
    await insert('m-promo', 'customer-acme', 'promoted acme fact', 1, { type: 'memory', promoted_to: 'system_prompt' });
    await insert('m-other', 'customer-globex', 'globex fix that also applies to acme', 1, { type: 'memory' }, 'bob');
    await insert('m-far', 'customer-globex', 'unrelated globex note', 50, { type: 'memory' }, 'bob');
    await insert('m-private', 'private-alice', 'private note', 1, { type: 'memory' });
    await insert('alice-1', 'customer-acme', 'Send sizing doc to acme', 3, { type: 'task', status: 'in_progress', priority: 'high', notes: 'waiting on numbers', depends_on: ['bob-1'], due_date: NOW + 86400 });
    await insert('bob-1', 'customer-acme', 'Collect acme numbers', 4, { type: 'task', status: 'pending', priority: 'critical' }, 'bob');
    await insert('bob-2', 'customer-acme', 'Old acme task', 5, { type: 'task', status: 'complete', priority: 'low' }, 'bob');

    const url = new URL(db.runtimeUrl);
    url.username = MCP_ROLE;
    url.password = password;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4, statement_timeout: 5000 });
    app = createApp({
      pool,
      config: { rateLimits: false, writesEnabled: false },
      authenticator: new McpAuthenticator({
        config: { authMode: 'insecure-test', staticKeys: new Map(), keyHeader: 'x-yapa-key' },
        lookupUser: email => findUserByEmail(pool, email),
      }),
      embedder,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
    restoreLog?.();
  });

  it('the mcp role can read but not write (grants + RLS)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('yapa.user', 'alice', true)");
      expect((await c.query("SELECT count(*)::int AS n FROM documents WHERE collection = 'private-alice'")).rows[0].n).toBe(0);
      expect((await c.query('SELECT count(*)::int AS n FROM documents')).rows[0].n).toBe(9);
      await expect(c.query("UPDATE documents SET content = 'x' WHERE id = 'm-1'")).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
      await expect(pool.query("DELETE FROM documents WHERE id = 'm-1'")).rejects.toThrow(/permission denied/);
      await expect(pool.query("INSERT INTO audit_log (actor, actor_email, request_id, action, doc_id, collection, row_owner, change_class) VALUES ('a','a','r','x','d','c','o','own')")).rejects.toThrow(/permission denied/);
    } finally {
      c.release();
    }
  });

  it('memory_recall: scope hits ranked, archived/promoted hidden, labeled cross-collection extras, authors shown', async () => {
    const r = await call('memory_recall', { query: 'seed:1 acme', collection: 'customer-acme', n_results: 5, include_tasks: false });
    expect(r.isError).toBe(false);
    const ids = [...r.text.matchAll(/\*\*([^*]+)\*\*/g)].map(m => m[1]);
    expect(ids[0]).toBe('m-1');
    expect(ids).toContain('m-2');
    expect(ids).toContain('m-other'); // strong match from another collection
    expect(ids).not.toContain('m-far');
    expect(ids).not.toContain('m-arch');
    expect(ids).not.toContain('m-promo');
    expect(ids).not.toContain('m-private');
    expect(ids).not.toContain('alice-1'); // tasks are not memories
    expect(r.text).toContain('customer-globex, other collection, by bob');
    expect(r.text).toContain('by bob, edited by alice');
  });

  it('memory_recall without collection searches all shared collections; other_collections 0 keeps to scope', async () => {
    const all = await call('memory_recall', { query: 'seed:1' });
    expect(all.text).toContain('m-other');
    const scoped = await call('memory_recall', { query: 'seed:1', collection: 'customer-acme', other_collections: 0 });
    expect(scoped.text).not.toContain('m-other');
  });

  it('memory_recall appends open follow-ups: all open tasks of the focused customer, priority first', async () => {
    const r = await call('memory_recall', { query: 'seed:1 acme', collection: 'customer-acme' });
    const tail = r.text.slice(r.text.indexOf('Open follow-ups for customer-acme'));
    expect(tail).toMatch(/^Open follow-ups for customer-acme \(recently updated first, then by priority\):/);
    expect(tail.indexOf('**bob-1**')).toBeLessThan(tail.indexOf('**alice-1**')); // critical before high
    expect(tail).not.toContain('bob-2'); // complete
    const none = await call('memory_recall', { query: 'seed:1 acme', collection: 'customer-acme', include_tasks: 'false' });
    expect(none.text).not.toContain('Open follow-ups');
  });

  it('memory_list pages newest first with a cursor', async () => {
    const p1 = await call('memory_list', { collection: 'customer-acme', limit: 1 });
    expect(p1.text).toContain('**m-2**');
    const cursor = /cursor "([^"]+)"/.exec(p1.text)![1];
    const p2 = await call('memory_list', { collection: 'customer-acme', limit: 1, cursor });
    expect(p2.text).toContain('**m-1**');
    expect(p2.text).not.toContain('cursor "');
    expect((await call('memory_list', { collection: 'customer-globex', cursor })).isError).toBe(true);
  });

  it('task_list sorts by priority, hides completed by default, and gives full detail by id', async () => {
    const r = await call('task_list', { collection: 'customer-acme' });
    expect(r.text.indexOf('bob-1')).toBeLessThan(r.text.indexOf('alice-1'));
    expect(r.text).not.toContain('bob-2');
    expect(r.text).toMatch(/\(by bob, updated \d{4}-\d{2}-\d{2}\) \[customer-acme\]/);
    expect((await call('task_list', { collection: 'customer-acme', include_complete: true })).text).toContain('bob-2');
    const d = await call('task_list', { id: 'alice-1' });
    expect(d.text).toContain('Notes: waiting on numbers');
    expect(d.text).toContain('Depends on: bob-1');
    expect(d.text).toContain('Owner: alice');
    expect((await call('task_list', { id: 'm-1' })).text).toBe('Task m-1 not found.');
  });

  it('task_search finds tasks by similarity', async () => {
    const r = await call('task_search', { query: 'seed:4', collection: 'customer-acme' });
    expect(r.text.split('\n')[0]).toContain('**bob-1**');
    expect(r.text).toContain('similarity: 1.000');
  });

  it('collection_list shows shared collections only', async () => {
    const r = await call('collection_list', {});
    expect(r.text).toContain('**customer-acme**: 7 documents');
    expect(r.text).not.toContain('private-alice');
  });

  it('collection_changes returns compact items since a date and a cursor that continues', async () => {
    const r = await call('collection_changes', { collection: 'customer-acme', since: new Date((NOW - 3600) * 1000).toISOString() });
    expect(r.text).toMatch(/^Changes in customer-acme: 7 document\(s\), 0 deletion\(s\)/);
    expect(r.text).toContain('task **alice-1** (by alice, in_progress/high)');
    expect(r.text).toContain('memory **m-arch** (by alice, archived)');
    const cursor = /cursor "([^"]+)"/.exec(r.text)![1];
    const again = await call('collection_changes', { collection: 'customer-acme', cursor });
    expect(again.text).toMatch(/0 document\(s\), 0 deletion\(s\)/);
    expect((await call('collection_changes', { collection: 'customer-acme' })).isError).toBe(true);
    expect((await call('collection_changes', { collection: 'customer-acme', since: NOW + 60 })).text).toMatch(/0 document/);
  });

  it('local-only collections are refused before SQL', async () => {
    const r = await call('memory_recall', { query: 'seed:1', collection: 'global' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('local_only_collection');
  });

  // Runs last: adds rows the counts above don't expect.
  it('form-style blanks, plain customer names, inferred focus and whole (stitched) memories', async () => {
    const chunk = { type: 'memory', salience: 3, parent_id: 'm-long', chunk_total: 2 };
    await insert('m-long-0', 'customer-acme-ct', 'Acme CT shadow link plan: phase one covers the orders topic and the DR runbook overlap text', 7, { ...chunk, chunk_index: 0 });
    await insert('m-long-1', 'customer-acme-ct', 'the DR runbook overlap text, then phase two adds consumer groups.', 8, { ...chunk, chunk_index: 1 });

    // ADP's form sends "" for blank fields.
    const blank = await call('memory_recall', { query: 'seed:1', collection: '', n_results: '', other_collections: '' });
    expect(blank.isError).toBe(false);
    expect(blank.text).toContain('m-1');

    // A plain name where an id is expected.
    const listed = await call('memory_list', { collection: 'Acme CT' });
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain('[customer-acme-ct]');
    expect((await call('memory_list', { collection: 'nope' })).text).toContain('no shared collection matches');

    // The question names the customer: focus line, and a chunk hit comes back whole, once.
    const r = await call('memory_recall', { query: "seed:8 what's the status of Acme CT's shadow link?", n_results: 5 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Focused on customer-acme-ct');
    expect(r.text).toContain('**m-long**');
    expect(r.text).not.toContain('m-long-0');
    expect(r.text).not.toContain('m-long-1');
    expect(r.text).toContain('phase one covers the orders topic and the DR runbook overlap text, then phase two adds consumer groups.');
    expect(r.text.match(/DR runbook overlap text/g)).toHaveLength(1);
  });

  // Runs last too: its own collection, so the counts above are unaffected.
  it('"latest" questions surface the newest memory and new follow-ups lead the task list', async () => {
    // A newer note that matches less well (cosine distance ~0.15) than 25 older exact matches.
    const DAY = 86400;
    const q = unitVector(9);
    const other = unitVector(77);
    const mix = q.map((x, i) => 0.85 * x + 0.5 * other[i]);
    const norm = Math.hypot(...mix);
    const near = mix.map(x => x / norm);
    const d = 1 - near.reduce((acc, x, i) => acc + x * q[i], 0);
    expect(d).toBeGreaterThan(0.05);
    expect(d).toBeLessThan(0.25);
    for (let i = 0; i < 25; i++) await insert(`m-old-${i}`, 'customer-initech', `initech july notes ${i}`, 9, { type: 'memory', salience: 1 }, 'alice', null, 90 * DAY);
    await insert('m-new', 'customer-initech', 'initech oct 12 roadmap call', 1, { type: 'memory', salience: 1 }, 'alice', null, DAY);
    await db.adminPool.query("UPDATE documents SET embedding = $1::vector WHERE id = 'm-new'", [`[${near.join(',')}]`]);
    for (let i = 0; i < 9; i++) await insert(`alice-${100 + i}`, 'customer-initech', `old high task ${i}`, 60 + i, { type: 'task', status: 'pending', priority: 'high' }, 'alice', null, 30 * DAY);
    await insert('alice-200', 'customer-initech', 'confirm onsite dates', 80, { type: 'task', status: 'pending', priority: 'medium' }, 'alice', null, DAY);

    const plain = await call('memory_recall', { query: 'seed:9 initech notes' });
    expect(plain.text).not.toContain('m-new');
    const latest = await call('memory_recall', { query: 'seed:9 latest initech notes' });
    const ids = [...latest.text.matchAll(/\*\*([^*]+)\*\*/g)].map(m => m[1]);
    expect(ids[0]).toBe('m-new');
    const tail = latest.text.slice(latest.text.indexOf('Open follow-ups for customer-initech'));
    expect(tail.split('\n')[1]).toContain('**alice-200**'); // newest first, despite medium priority
  });
});
