/**
 * Soft delete, restore, purge and retention (schema v4, 07_soft_delete.sql)
 * against a real Postgres with the production schema, grants and RLS (see
 * pgsetup.ts). Skipped unless YAPA_SERVICE_IT_DATABASE_URL is set; see
 * integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { InsecureTestVerifier } from '../src/auth.js';
import { DEFAULT_RATE_LIMITS } from '../src/config.js';
import { setLogSink } from '../src/log.js';
import { RetentionSweeper } from '../src/retention.js';
import { purgeExpiredDeleted, RESTORE_DEVICE } from '../src/store.js';
import { createItDb, type ItDb } from './pgsetup.js';

const URL_ = process.env.YAPA_SERVICE_IT_DATABASE_URL;
const NOW = Math.floor(Date.now() / 1000);
const C = 'customer-acme';

function unitVector(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * (i + 1)) + 0.01 * seed);
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

function doc(id: string, collection = C, extra: Record<string, unknown> = {}) {
  return {
    id, collection, content: `content of ${id} `.repeat(40), embedding: unitVector(id.length + id.charCodeAt(0)),
    metadata: { type: 'memory', tags: ['x'] }, created_at: NOW - 100, updated_at: NOW - 50, ...extra,
  };
}

describe.skipIf(!URL_)('soft delete, restore and purge (real Postgres + RLS)', () => {
  let db: ItDb;
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let restoreLog: () => void;
  let sweeps = 0;

  const call = async (user: string, device: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
    if (user) h.authorization = `Bearer test:${user}@example.com`;
    if (device) h['x-yapa-device'] = device;
    const r = await app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined, headers: r.headers };
  };
  const upsert = (user: string, device: string, docs: unknown[]) => call(user, device, 'POST', '/v1/documents:batchUpsert', { documents: docs });
  const del = (user: string, ids: string[], reason?: string) => call(user, 'A', 'POST', '/v1/documents:batchDelete', { ids, ...(reason ? { reason } : {}) });
  const restore = (user: string, ids: string[], device = 'A', headers?: Record<string, string>) => call(user, device, 'POST', '/v1/documents:restore', { ids }, headers);
  const purge = (user: string, ids: string[], headers?: Record<string, string>) => call(user, 'A', 'POST', '/v1/documents:purge', { ids }, headers);
  const listDeleted = (user: string, qs = '') => call(user, 'A', 'GET', `/v1/me/deleted${qs}`);
  const pull = (user: string, device: string, collection = C) => call(user, device, 'GET', `/v1/collections/${collection}/documents?since=0&embeddings=false`);
  const admin = (sql: string, values: unknown[] = []) => db.adminPool.query(sql, values);
  const auditActions = async (id: string) => (await admin('SELECT action FROM audit_log WHERE doc_id = $1 ORDER BY seq', [id])).rows.map(r => r.action);

  beforeAll(async () => {
    restoreLog = setLogSink(() => undefined);
    db = await createItDb(URL_!);
    await admin(`INSERT INTO users (username, email, active) VALUES ('alice', 'alice@example.com', true), ('bob', 'bob@example.com', true)`);
    pool = new pg.Pool({ connectionString: db.runtimeUrl, max: 4, statement_timeout: 5000 });
    app = createApp({
      pool,
      config: { similarityThreshold: 0.95, rateLimits: DEFAULT_RATE_LIMITS, dailyWriteAlert: 20000, deletedRetentionDays: 30 },
      verifier: new InsecureTestVerifier(),
      // Routes must keep working whatever the sweep does; count the triggers.
      sweeper: new RetentionSweeper(async () => { sweeps++; return 0; }, 0),
    });
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
    restoreLog?.();
  });

  it('schema v4 is recorded and the runtime cannot update or truncate the new tables', async () => {
    expect((await admin('SELECT max(version)::int AS v FROM schema_version')).rows[0].v).toBe(4);
    const r = await admin(
      `SELECT c.relname, has_table_privilege('yapa_it_runtime', c.oid, 'UPDATE') AS upd, has_table_privilege('yapa_it_runtime', c.oid, 'TRUNCATE') AS trunc,
              has_table_privilege('yapa_it_runtime', c.oid, 'DELETE') AS del, c.relrowsecurity AS rls
         FROM pg_class c WHERE c.relname IN ('deleted_documents', 'purged_ids') ORDER BY 1`,
    );
    expect(r.rows).toEqual([
      { relname: 'deleted_documents', upd: false, trunc: false, del: true, rls: true },
      { relname: 'purged_ids', upd: false, trunc: false, del: false, rls: true },
    ]);
  });

  it('delete moves the row into deleted_documents and the feed carries the reason', async () => {
    await upsert('alice', 'A', [doc('sd-1'), doc('sd-ret-1')]);
    const before = (await admin("SELECT content, metadata, origin_user, created_at, related_ids FROM documents WHERE id = 'sd-1'")).rows[0];
    const sweepsBefore = sweeps;
    expect((await del('alice', ['sd-1'])).body).toEqual({ results: [{ id: 'sd-1', status: 'deleted' }], deleted: 1 });
    expect(sweeps).toBeGreaterThan(sweepsBefore);
    await del('alice', ['sd-ret-1'], 'retract');

    expect((await admin("SELECT count(*)::int AS n FROM documents WHERE id IN ('sd-1', 'sd-ret-1')")).rows[0].n).toBe(0);
    const kept = (await admin("SELECT id, content, metadata, origin_user, created_at, related_ids, deleted_by, reason, vector_dims(embedding) AS dims FROM deleted_documents WHERE id IN ('sd-1', 'sd-ret-1') ORDER BY id")).rows;
    expect(kept[0]).toEqual({ id: 'sd-1', ...before, deleted_by: 'alice', reason: 'delete', dims: 384 });
    expect(kept[1]).toMatchObject({ id: 'sd-ret-1', reason: 'retract' });

    const feed = (await pull('bob', 'B')).body.deletions;
    expect(feed).toEqual(expect.arrayContaining([
      { id: 'sd-1', deleted_by: 'alice', deleted_at: expect.any(Number), reason: 'delete', purged: false },
      { id: 'sd-ret-1', deleted_by: 'alice', deleted_at: expect.any(Number), reason: 'retract', purged: false },
    ]));
  });

  it('listDeleted shows only the caller\'s own rows, with a 300-character preview, filterable by collection', async () => {
    await upsert('bob', 'B', [doc('sd-bob-1'), doc('sd-bob-2', 'project-other')]);
    await del('bob', ['sd-bob-1', 'sd-bob-2']);

    const alice = await listDeleted('alice');
    expect(alice.status).toBe(200);
    expect(alice.body.documents.map((d: { id: string }) => d.id).sort()).toEqual(['sd-1', 'sd-ret-1']);
    const one = alice.body.documents.find((d: { id: string }) => d.id === 'sd-1');
    expect(one).toEqual({ id: 'sd-1', collection: C, content: doc('sd-1').content.slice(0, 300), metadata: expect.objectContaining({ type: 'memory', tags: ['x'] }), deleted_at: expect.any(Number), reason: 'delete' });

    const bob = await listDeleted('bob', '?collection=project-other&limit=10');
    expect(bob.body.documents.map((d: { id: string }) => d.id)).toEqual(['sd-bob-2']);
    expect((await listDeleted('bob', '?limit=1')).body.documents).toHaveLength(1);
    expect((await listDeleted('bob', '?collection=private-x')).status).toBe(403);
    expect((await listDeleted('bob', '?limit=0')).status).toBe(400);

    // RLS backs the owner filter: bob's transaction cannot see alice's rows at all.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('yapa.user', 'bob', true)");
      expect((await c.query("SELECT id FROM deleted_documents WHERE id = 'sd-1'")).rowCount).toBe(0);
      expect((await c.query("DELETE FROM deleted_documents WHERE id = 'sd-1'")).rowCount).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('restore brings the row back with a newer updated_at, pullable by every device including the restoring one; no feed entry', async () => {
    const deletedBefore = (await pull('bob', 'B')).body.deletions.length;
    const r = await restore('alice', ['sd-1', 'sd-missing']);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ results: [{ id: 'sd-1', status: 'restored', synced_at: expect.any(Number) }, { id: 'sd-missing', status: 'not_found' }], restored: 1 });

    const row = (await admin("SELECT origin_user, last_editor, last_device, floor(extract(epoch from updated_at))::bigint AS u, floor(extract(epoch from created_at))::bigint AS cr FROM documents WHERE id = 'sd-1'")).rows[0];
    expect(row).toMatchObject({ origin_user: 'alice', last_editor: 'alice', last_device: RESTORE_DEVICE, cr: String(NOW - 100) });
    expect(Number(row.u)).toBeGreaterThan(NOW - 50);
    expect((await admin("SELECT count(*)::int AS n FROM deleted_documents WHERE id = 'sd-1'")).rows[0].n).toBe(0);

    for (const [user, device] of [['alice', 'A'], ['alice', 'C'], ['bob', 'B']]) {
      const ids = (await pull(user, device)).body.documents.map((d: { id: string }) => d.id);
      expect(ids, `${user}/${device}`).toContain('sd-1');
    }
    expect((await pull('bob', 'B')).body.deletions.length).toBe(deletedBefore);
    expect(await auditActions('sd-1')).toEqual(['insert', 'delete', 'restore']);
    expect((await listDeleted('alice')).body.documents.map((d: { id: string }) => d.id)).not.toContain('sd-1');
  });

  it('restore refuses id_taken when a live row with that id exists now', async () => {
    await upsert('alice', 'A', [doc('sd-2')]);
    await del('alice', ['sd-2']);
    await upsert('alice', 'A', [{ ...doc('sd-2'), content: 'a new doc under the old id' }]);
    expect((await restore('alice', ['sd-2'])).body.results).toEqual([{ id: 'sd-2', status: 'id_taken' }]);
    expect((await admin("SELECT content FROM documents WHERE id = 'sd-2'")).rows[0].content).toBe('a new doc under the old id');
    expect((await admin("SELECT count(*)::int AS n FROM deleted_documents WHERE id = 'sd-2'")).rows[0].n).toBe(1);
  });

  it('a non-owner cannot restore or purge', async () => {
    // bob cannot see alice's deleted row: not_found, nothing changes.
    expect((await restore('bob', ['sd-ret-1'], 'B')).body.results).toEqual([{ id: 'sd-ret-1', status: 'not_found' }]);
    expect((await purge('bob', ['sd-ret-1'])).body.results).toEqual([{ id: 'sd-ret-1', status: 'not_found' }]);
    // A live row of alice's: not_owner.
    const p = await purge('bob', ['sd-1']);
    expect(p.body).toEqual({ results: [{ id: 'sd-1', status: 'error', error: { code: 'not_owner', message: expect.any(String) } }], purged: 0 });
    expect((await admin("SELECT count(*)::int AS n FROM documents WHERE id = 'sd-1'")).rows[0].n).toBe(1);
    expect((await admin("SELECT count(*)::int AS n FROM deleted_documents WHERE id = 'sd-ret-1'")).rows[0].n).toBe(1);
    expect((await admin("SELECT count(*)::int AS n FROM purged_ids")).rows[0].n).toBe(0);
  });

  it('purge removes the live row and every deleted copy, feeds purged = true, and later upserts are refused with purged', async () => {
    // sd-2: one deleted copy plus a live row, both alice's.
    const r = await purge('alice', ['sd-2', 'sd-ret-1', 'sd-none'], { 'idempotency-key': 'purge-1' });
    expect(r.body).toEqual({
      results: [{ id: 'sd-2', status: 'purged' }, { id: 'sd-ret-1', status: 'purged' }, { id: 'sd-none', status: 'not_found' }],
      purged: 2,
    });
    // A retried request replays instead of re-running.
    const again = await purge('alice', ['sd-2', 'sd-ret-1', 'sd-none'], { 'idempotency-key': 'purge-1' });
    expect([again.headers.get('idempotent-replay'), again.body.purged]).toEqual(['true', 2]);

    expect((await admin("SELECT count(*)::int AS n FROM documents WHERE id IN ('sd-2', 'sd-ret-1')")).rows[0].n).toBe(0);
    expect((await admin("SELECT count(*)::int AS n FROM deleted_documents WHERE id IN ('sd-2', 'sd-ret-1')")).rows[0].n).toBe(0);
    expect((await admin("SELECT id, purged_by FROM purged_ids ORDER BY id")).rows).toEqual([{ id: 'sd-2', purged_by: 'alice' }, { id: 'sd-ret-1', purged_by: 'alice' }]);

    const feed = (await pull('bob', 'B')).body.deletions.filter((d: { purged: boolean }) => d.purged);
    expect(feed.map((d: { id: string }) => d.id).sort()).toEqual(['sd-2', 'sd-ret-1']);
    expect(feed[0]).toMatchObject({ deleted_by: 'alice', reason: 'delete', purged: true });
    expect(await auditActions('sd-2')).toEqual(['insert', 'delete', 'insert', 'purge']);

    for (const user of ['alice', 'bob']) {
      const up = await upsert(user, 'A', [doc('sd-2')]);
      expect(up.body.results[0]).toEqual({ id: 'sd-2', status: 'error', error: { code: 'purged', message: expect.any(String) } });
      const put = await call(user, 'A', 'PUT', '/v1/documents/sd-2', doc('sd-2'));
      expect([put.status, put.body.error.code]).toEqual([410, 'purged']);
    }
    expect((await admin("SELECT count(*)::int AS n FROM documents WHERE id = 'sd-2'")).rows[0].n).toBe(0);
    expect((await restore('alice', ['sd-2'])).body.results).toEqual([{ id: 'sd-2', status: 'not_found' }]);
  });

  it('retention: rows older than the window are not listed or restorable, and the sweep removes every user\'s', async () => {
    await upsert('alice', 'A', [doc('sd-old-a')]);
    await upsert('bob', 'B', [doc('sd-old-b')]);
    await del('alice', ['sd-old-a']);
    await del('bob', ['sd-old-b']);
    await admin("UPDATE deleted_documents SET deleted_at = now() - interval '31 days' WHERE id IN ('sd-old-a', 'sd-old-b')");

    expect((await listDeleted('alice')).body.documents.map((d: { id: string }) => d.id)).not.toContain('sd-old-a');
    expect((await restore('alice', ['sd-old-a'])).body.results).toEqual([{ id: 'sd-old-a', status: 'not_found' }]);

    const keptBefore = (await admin('SELECT count(*)::int AS n FROM deleted_documents')).rows[0].n;
    expect(await purgeExpiredDeleted(pool, 30)).toBe(2);
    expect((await admin("SELECT count(*)::int AS n FROM deleted_documents WHERE id IN ('sd-old-a', 'sd-old-b')")).rows[0].n).toBe(0);
    expect((await admin('SELECT count(*)::int AS n FROM deleted_documents')).rows[0].n).toBe(keptBefore - 2);
    await expect(purgeExpiredDeleted(pool, 0)).rejects.toThrow(/at least 1 day/);

    // The default sweeper wiring: a request starts it, the next one within 5 minutes does not.
    await upsert('alice', 'A', [doc('sd-old-c')]);
    await del('alice', ['sd-old-c']);
    await admin("UPDATE deleted_documents SET deleted_at = now() - interval '40 days' WHERE id = 'sd-old-c'");
    let started: Promise<void> | undefined;
    const real = new RetentionSweeper(() => purgeExpiredDeleted(pool, 30));
    const wired = createApp({
      pool,
      config: { similarityThreshold: 0.95, rateLimits: false, dailyWriteAlert: 20000 },
      verifier: new InsecureTestVerifier(),
      sweeper: { maybeSweep: () => (started ??= real.maybeSweep()) } as unknown as RetentionSweeper,
    });
    const res = await wired.request('/v1/me/deleted', { headers: { authorization: 'Bearer test:alice@example.com' } });
    expect(res.status).toBe(200);
    await started;
    expect((await admin("SELECT count(*)::int AS n FROM deleted_documents WHERE id = 'sd-old-c'")).rows[0].n).toBe(0);
    expect(real.maybeSweep()).toBeUndefined();
  });

  it('a failing sweep never fails the request', async () => {
    const failing = createApp({
      pool,
      config: { similarityThreshold: 0.95, rateLimits: false, dailyWriteAlert: 20000 },
      verifier: new InsecureTestVerifier(),
      sweeper: new RetentionSweeper(async () => { throw new Error('sweep broke'); }, 0),
    });
    const h = { authorization: 'Bearer test:alice@example.com', 'x-yapa-device': 'A' };
    expect((await failing.request('/v1/me/deleted', { headers: h })).status).toBe(200);
    expect((await failing.request(`/v1/collections/${C}/documents?since=0`, { headers: h })).status).toBe(200);
  });
});
