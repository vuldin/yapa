/**
 * Typed memories and task links (YAPA 1.6.0 metadata keys) against a real
 * Postgres with the production schema, grants and RLS (see pgsetup.ts). The
 * service treats these keys as opaque metadata (docs/sync-api.md sections 7
 * and 8): every key must come back on pull exactly as pushed, and a later
 * status-only edit must be accepted and served. Skipped unless
 * YAPA_SERVICE_IT_DATABASE_URL is set; see integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { InsecureTestVerifier } from '../src/auth.js';
import { setLogSink } from '../src/log.js';
import { createItDb, type ItDb } from './pgsetup.js';

const URL_ = process.env.YAPA_SERVICE_IT_DATABASE_URL;
const NOW = Math.floor(Date.now() / 1000);
const C = 'project-typed';

function unitVector(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * (i + 1)) + 0.01 * seed);
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

/** Every typed-memory key a 1.6.0 client may write (one memory carries them all). */
const TYPED_MEMORY_META = {
  type: 'memory',
  sector: 'semantic',
  salience: 2.5,
  tags: ['queue', 'latency'],
  kind: 'decision',
  status: 'needed',
  owner: 'alice',
  task_ids: ['alice-7'],
  options: ['keep the batch size at 1, which is simplest', 'raise it to 64'],
  recommendation: 'raise it to 64',
  disposition: 'task',
  disposition_ids: ['alice-7', 'alice-8'],
  disposition_reason: 'tracked as a task',
  exit_criteria: 'p99 under 5 ms at 64',
  external_ref: 'records/D-012.md',
};

const TYPED_TASK_META = {
  type: 'task',
  status: 'pending',
  priority: 'high',
  due_date: 0,
  memory_ids: ['typed-decision-1'],
  waits_on: ['typed-decision-1'],
  tags: ['needs-human', 'needs:alex', 'auto'],
};

describe.skipIf(!URL_)('typed memories and task links (real Postgres)', () => {
  let db: ItDb;
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let restoreLog: () => void;

  const call = async (user: string, device: string, method: string, path: string, body?: unknown) => {
    const h: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer test:${user}@example.com`, 'x-yapa-device': device };
    const r = await app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  const upsert = (user: string, device: string, docs: unknown[]) => call(user, device, 'POST', '/v1/documents:batchUpsert', { documents: docs });
  const pullAll = async (user: string, device: string) => {
    const r = await call(user, device, 'GET', `/v1/collections/${C}/documents?since=0&embeddings=false`);
    expect(r.status).toBe(200);
    return new Map<string, any>((r.body.documents as Array<{ id: string }>).map(d => [d.id, d]));
  };

  const memory = { id: 'typed-decision-1', collection: C, content: 'Batch size for the matching engine transform', embedding: unitVector(3), metadata: TYPED_MEMORY_META, created_at: NOW - 100, updated_at: NOW - 50 };
  const task = { id: 'alice-7', collection: C, content: 'Rerun the latency bench at batch 64', embedding: unitVector(4), metadata: TYPED_TASK_META, created_at: NOW - 90, updated_at: NOW - 40 };

  beforeAll(async () => {
    restoreLog = setLogSink(() => undefined);
    db = await createItDb(URL_!);
    await db.adminPool.query(`INSERT INTO users (username, email) VALUES ('alice', 'alice@example.com'), ('bob', 'bob@example.com')`);
    pool = new pg.Pool({ connectionString: db.runtimeUrl, max: 4, statement_timeout: 5000 });
    app = createApp({
      pool,
      config: { similarityThreshold: 0.95, rateLimits: false, dailyWriteAlert: 20000 },
      verifier: new InsecureTestVerifier(),
    });
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
    restoreLog?.();
  });

  it('every typed-memory and task-link key round-trips unchanged', async () => {
    const r = await upsert('alice', 'A', [memory, task]);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['inserted', 'inserted']);

    const docs = await pullAll('bob', 'B');
    const m = docs.get('typed-decision-1');
    const t = docs.get('alice-7');
    // Opaque: what was sent comes back, plus only the two keys the remote sets.
    expect(m.metadata).toEqual({ ...TYPED_MEMORY_META, origin_device: 'A', origin_user: 'alice' });
    expect(t.metadata).toEqual({ ...TYPED_TASK_META, origin_device: 'A', origin_user: 'alice' });
    // The option with a comma stays one array item; arrays stay arrays.
    expect(m.metadata.options).toHaveLength(2);
    expect(m.metadata.options[0]).toContain(',');
    expect(Array.isArray(t.metadata.waits_on)).toBe(true);
    expect(m).toMatchObject({ content: memory.content, origin_user: 'alice', updated_at: NOW - 50 });
    expect(t).toMatchObject({ content: task.content, origin_user: 'alice' });
  });

  it('a status-only update (by a teammate) is accepted and served on the next pull', async () => {
    const before = await pullAll('alice', 'C');
    const pos = Math.max(...[...before.values()].map(d => d.synced_at));
    const metadata = { ...TYPED_MEMORY_META, status: 'accepted' };
    const r = await upsert('bob', 'B', [{ ...memory, metadata, updated_at: NOW - 10 }]);
    expect(r.body.results[0]).toMatchObject({ id: 'typed-decision-1', status: 'updated' });
    expect(r.body.results[0].stale).toBeFalsy();

    const after = await pullAll('alice', 'A');
    const m = after.get('typed-decision-1');
    expect(m.metadata).toEqual({ ...metadata, origin_device: 'B', origin_user: 'alice' });
    expect(m).toMatchObject({ last_editor: 'bob', updated_at: NOW - 10 });
    expect(m.synced_at).toBeGreaterThanOrEqual(pos);
    // An incremental pull from the previous position carries it too.
    const inc = await call('alice', 'A', 'GET', `/v1/collections/${C}/documents?since=${pos}&embeddings=false`);
    expect(inc.body.documents.map((d: { id: string }) => d.id)).toContain('typed-decision-1');

    const audit = (await db.adminPool.query("SELECT action, changed_keys FROM audit_log WHERE doc_id = 'typed-decision-1' AND action = 'update'")).rows;
    expect(audit[0].changed_keys).toEqual(['origin_device', 'status']);
  });
});
