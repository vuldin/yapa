/**
 * End-to-end tests of API v1 against a real Postgres+pgvector with the
 * production schema, grants and RLS (see pgsetup.ts). Skipped unless
 * YAPA_SERVICE_IT_DATABASE_URL is set, e.g.:
 *
 *   docker run -d --rm --name yapa-it -e POSTGRES_PASSWORD=it -p 55432:5432 pgvector/pgvector:pg17
 *   YAPA_SERVICE_IT_DATABASE_URL=postgres://postgres:it@localhost:55432/postgres npm run test:integration -w packages/service
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { InsecureTestVerifier } from '../src/auth.js';
import { DEFAULT_RATE_LIMITS } from '../src/config.js';
import { setLogSink } from '../src/log.js';
import { createItDb, type ItDb } from './pgsetup.js';

const URL_ = process.env.YAPA_SERVICE_IT_DATABASE_URL;
const NOW = Math.floor(Date.now() / 1000);

function unitVector(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * (i + 1)) + 0.01 * seed);
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

function doc(id: string, collection: string, extra: Record<string, unknown> = {}) {
  return {
    id, collection, content: `content of ${id}`, embedding: unitVector(id.length + id.charCodeAt(0)),
    metadata: { type: 'memory' }, created_at: NOW - 100, updated_at: NOW - 50, ...extra,
  };
}

describe.skipIf(!URL_)('service integration (real Postgres + RLS)', () => {
  let db: ItDb;
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  const logs: string[] = [];
  let restoreLog: () => void;

  const call = async (user: string, device: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
    if (user) h.authorization = `Bearer test:${user}@example.com`;
    if (device) h['x-yapa-device'] = device;
    const r = await app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined, headers: r.headers };
  };
  const upsert = (user: string, device: string, docs: unknown[], headers?: Record<string, string>) =>
    call(user, device, 'POST', '/v1/documents:batchUpsert', { documents: docs }, headers);
  const pullAll = async (user: string, device: string, collection: string, qs = '') =>
    call(user, device, 'GET', `/v1/collections/${collection}/documents?since=0${qs}`);
  const auditRows = async (docId: string) =>
    (await db.adminPool.query('SELECT actor, action, row_owner, change_class, prev_editor, prev_collection, collection, device FROM audit_log WHERE doc_id = $1 ORDER BY seq', [docId])).rows;

  beforeAll(async () => {
    restoreLog = setLogSink(l => logs.push(l));
    db = await createItDb(URL_!);
    await db.adminPool.query(
      `INSERT INTO users (username, email, active) VALUES
         ('alice', 'alice@example.com', true), ('bob', 'bob@example.com', true), ('carol', 'carol@example.com', false)`,
    );
    pool = new pg.Pool({ connectionString: db.runtimeUrl, max: 4, statement_timeout: 5000 });
    app = createApp({
      pool,
      config: { similarityThreshold: 0.95, rateLimits: DEFAULT_RATE_LIMITS, dailyWriteAlert: 20000 },
      verifier: new InsecureTestVerifier(),
    });
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
    restoreLog?.();
  });

  it('runs as a non-owner role subject to RLS', async () => {
    const r = await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    expect((await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'documents'")).rows[0].relrowsecurity).toBe(true);
  });

  it('health and identity', async () => {
    expect((await call('alice', 'A', 'GET', '/v1/health')).status).toBe(200);
    expect((await call('alice', 'A', 'GET', '/v1/me')).body).toMatchObject({ username: 'alice', email: 'alice@example.com' });
  });

  describe('multi-user model', () => {
    it('insert is attributed to the caller; echo suppression by device', async () => {
      const r = await upsert('alice', 'A', [{ ...doc('acme-note-1', 'customer-acme'), origin_user: 'bob' }]);
      expect(r.status).toBe(200);
      expect(r.body.results[0]).toMatchObject({ id: 'acme-note-1', status: 'inserted' });

      const row = (await db.adminPool.query("SELECT origin_user, last_editor, last_device, metadata FROM documents WHERE id = 'acme-note-1'")).rows[0];
      expect(row).toMatchObject({ origin_user: 'alice', last_editor: 'alice', last_device: 'A' });
      expect(row.metadata.origin_device).toBe('A');

      const ids = (res: { body: { documents: Array<{ id: string }> } }) => res.body.documents.map(d => d.id);
      expect(ids(await pullAll('alice', 'A', 'customer-acme'))).toEqual([]); // own device echo
      expect(ids(await pullAll('alice', 'C', 'customer-acme'))).toEqual(['acme-note-1']); // alice's other device
      expect(ids(await pullAll('bob', 'B', 'customer-acme'))).toEqual(['acme-note-1']);
      expect(ids(await pullAll('alice', 'A', 'customer-acme', '&include_own_device=true'))).toEqual(['acme-note-1']); // recovery

      const pulled = (await pullAll('bob', 'B', 'customer-acme')).body.documents[0];
      expect(pulled).toMatchObject({ origin_user: 'alice', last_editor: 'alice', collection: 'customer-acme', created_at: NOW - 100 });
      expect(pulled.embedding).toHaveLength(384);
      expect((await pullAll('bob', 'B', 'customer-acme', '&embeddings=false')).body.documents[0].embedding).toBeUndefined();
    });

    it('legacy rows of the caller without a device stamp are echoes', async () => {
      await db.adminPool.query(
        `INSERT INTO documents (id, collection, content, embedding, metadata, origin_user, created_at, updated_at)
         VALUES ('legacy-1', 'customer-legacy', 'old', $1::vector, '{}', 'alice', now(), now())`,
        [`[${unitVector(9).join(',')}]`],
      );
      expect((await pullAll('alice', 'Z', 'customer-legacy')).body.documents).toEqual([]);
      expect((await pullAll('bob', 'B', 'customer-legacy')).body.documents.map((d: { id: string }) => d.id)).toEqual(['legacy-1']);
    });

    it('echo spoof: a teammate writing with the owner device id cannot hide the edit from the owner', async () => {
      await upsert('alice', 'A', [doc('spoof-1', 'customer-spoof')]);
      // Bob claims alice's device id, in the header and in metadata.
      const r = await upsert('bob', 'A', [{ ...doc('spoof-1', 'customer-spoof'), content: 'bob sneaky edit', updated_at: NOW, metadata: { type: 'memory', origin_device: 'A' } }]);
      expect(r.body.results[0]).toMatchObject({ status: 'updated' });
      const got = (await pullAll('alice', 'A', 'customer-spoof')).body.documents;
      expect(got.map((d: { id: string }) => d.id)).toEqual(['spoof-1']);
      expect(got[0]).toMatchObject({ content: 'bob sneaky edit', last_editor: 'bob' });
      // Only bob's own device-A pulls treat it as an echo.
      expect((await pullAll('bob', 'A', 'customer-spoof')).body.documents).toEqual([]);
      expect((await pullAll('bob', 'B', 'customer-spoof')).body.documents).toHaveLength(1);

      // A client-supplied metadata.origin_device is overwritten with the header device.
      await upsert('bob', 'B', [{ ...doc('spoof-2', 'customer-spoof'), metadata: { type: 'memory', origin_device: 'A' } }]);
      const row = (await db.adminPool.query("SELECT last_device, metadata FROM documents WHERE id = 'spoof-2'")).rows[0];
      expect(row.last_device).toBe('B');
      expect(row.metadata.origin_device).toBe('B');
      expect((await pullAll('alice', 'A', 'customer-spoof')).body.documents.map((d: { id: string }) => d.id).sort()).toEqual(['spoof-1', 'spoof-2']);
    });

    it('teammate update: allowed, attributed, audited with overwrote_teammate_edit; origin_user/created_at immutable', async () => {
      const r = await upsert('bob', 'B', [{ ...doc('acme-note-1', 'customer-acme'), content: 'bob edit', created_at: NOW - 5000, updated_at: NOW }]);
      expect(r.body.results[0]).toMatchObject({ status: 'updated' });
      const row = (await db.adminPool.query("SELECT origin_user, last_editor, last_device, extract(epoch from created_at)::bigint AS c, metadata FROM documents WHERE id = 'acme-note-1'")).rows[0];
      expect(row).toMatchObject({ origin_user: 'alice', last_editor: 'bob', last_device: 'B' });
      expect(Number(row.c)).toBe(NOW - 100);
      expect(row.metadata.origin_user).toBe('alice');

      const audit = await auditRows('acme-note-1');
      expect(audit.map(a => a.action)).toEqual(['insert', 'update', 'overwrote_teammate_edit']);
      expect(audit[1]).toMatchObject({ actor: 'bob', row_owner: 'alice', change_class: 'teammate', prev_editor: 'alice', device: 'B' });
      expect(audit[2]).toMatchObject({ actor: 'bob', prev_editor: 'alice' });

      // Bob's own device now treats the row as an echo; alice's device A sees bob's edit.
      expect((await pullAll('bob', 'B', 'customer-acme')).body.documents).toEqual([]);
      expect((await pullAll('alice', 'A', 'customer-acme')).body.documents[0]).toMatchObject({ content: 'bob edit', last_editor: 'bob' });

      // Alice re-editing replaces bob's version: another overwrote event, now with prev_editor bob.
      await upsert('alice', 'A', [{ ...doc('acme-note-1', 'customer-acme'), content: 'alice again', updated_at: NOW - 10 }]);
      const after = await auditRows('acme-note-1');
      expect(after.slice(3).map(a => [a.action, a.change_class, a.prev_editor])).toEqual([['update', 'own', 'bob'], ['overwrote_teammate_edit', 'own', 'bob']]);
      // Stale write (stored updated_at was newer) is flagged.
      expect((await upsert('alice', 'A', [{ ...doc('acme-note-1', 'customer-acme'), content: 'stale', updated_at: NOW - 40 }])).body.results[0]).toMatchObject({ status: 'updated', stale: true });
      // A write by the same writer over their own version adds no overwrite event.
      expect((await auditRows('acme-note-1')).filter(a => a.action === 'overwrote_teammate_edit')).toHaveLength(2);
    });

    it('writes a structured audit line to stdout without content', () => {
      const audits = logs.map(l => JSON.parse(l)).filter(l => l.message === 'audit');
      expect(audits.length).toBeGreaterThan(0);
      expect(audits[0]).toMatchObject({ severity: 'INFO', audit: { actor: 'alice', action: 'insert', doc_id: 'acme-note-1', collection: 'customer-acme' } });
      expect(logs.join('\n')).not.toContain('bob edit');
    });

    it('owner-only delete feeds the deletions feed', async () => {
      await upsert('alice', 'A', [doc('acme-del-1', 'customer-acme')]);
      const byBob = await call('bob', 'B', 'POST', '/v1/documents:batchDelete', { ids: ['acme-del-1', 'missing-1'] });
      expect(byBob.status).toBe(200);
      expect(byBob.body).toEqual({
        results: [{ id: 'acme-del-1', status: 'error', error: { code: 'not_owner', message: expect.any(String) } }, { id: 'missing-1', status: 'not_found' }],
        deleted: 0,
      });
      const byAlice = await call('alice', 'A', 'POST', '/v1/documents:batchDelete', { ids: ['acme-del-1'] });
      expect(byAlice.body).toEqual({ results: [{ id: 'acme-del-1', status: 'deleted' }], deleted: 1 });

      const feed = (await pullAll('bob', 'B', 'customer-acme')).body.deletions;
      expect(feed).toEqual([{ id: 'acme-del-1', deleted_by: 'alice', deleted_at: expect.any(Number) }]);
      expect((await auditRows('acme-del-1')).map(a => a.action)).toEqual(['insert', 'delete']);

      const retract = await upsert('alice', 'A', [doc('acme-ret-1', 'customer-acme')]);
      expect(retract.body.results[0].status).toBe('inserted');
      await call('alice', 'A', 'POST', '/v1/documents:batchDelete', { ids: ['acme-ret-1'], reason: 'retract' });
      expect((await auditRows('acme-ret-1')).map(a => a.action)).toEqual(['insert', 'retract']);
    });

    it('collection move between shared collections', async () => {
      await upsert('alice', 'A', [doc('move-1', 'customer-acme')]);
      const r = await upsert('bob', 'B', [doc('move-1', 'project-moved')]);
      expect(r.body.results[0].status).toBe('updated');
      expect((await call('alice', 'A', 'POST', '/v1/documents:collections', { ids: ['move-1', 'nope'] })).body).toEqual({ collections: { 'move-1': 'project-moved' } });
      expect((await pullAll('alice', 'A', 'project-moved')).body.documents.map((d: { id: string }) => d.id)).toEqual(['move-1']);
      const audit = await auditRows('move-1');
      expect(audit[1]).toMatchObject({ action: 'move', prev_collection: 'customer-acme', collection: 'project-moved', change_class: 'teammate' });
      // Moving into a local-only collection is never a server call.
      expect((await upsert('alice', 'A', [doc('move-1', 'private-mine')])).body.results[0].error.code).toBe('local_only_collection');
    });
  });

  describe('authz negatives', () => {
    it('no token -> 401; unmapped -> 403 not_member; inactive -> 403 user_inactive, re-enabled immediately', async () => {
      expect((await call('', 'A', 'GET', '/v1/collections')).status).toBe(401);
      const unk = await call('mallory', 'M', 'GET', '/v1/collections');
      expect([unk.status, unk.body.error.code]).toEqual([403, 'not_member']);
      const inactive = await call('carol', 'K', 'POST', '/v1/documents:batchUpsert', { documents: [doc('carol-1', 'customer-acme')] });
      expect([inactive.status, inactive.body.error.code]).toEqual([403, 'user_inactive']);
      await db.adminPool.query("UPDATE users SET active = true WHERE username = 'carol'");
      expect((await call('carol', 'K', 'GET', '/v1/me')).status).toBe(200);
      await db.adminPool.query("UPDATE users SET active = false, disabled_at = now() WHERE username = 'carol'");
      expect((await call('carol', 'K', 'GET', '/v1/me')).status).toBe(403);
      expect(logs.some(l => l.includes('"event":"auth_failure"') && l.includes('"reason":"user_inactive"'))).toBe(true);
    });

    it('cannot write as another user: body attribution is ignored, task ids need the caller prefix', async () => {
      const r = await call('alice', 'A', 'PUT', '/v1/documents/bob-7', { ...doc('bob-7', 'project-yapa'), metadata: { type: 'task' }, origin_user: 'bob' });
      expect([r.status, r.body.error.code]).toEqual([403, 'task_namespace']);
      expect(r.body.error.details.suggested_id).toMatch(/^alice-\d+$/);
      // A non-task doc may not squat a teammate's task namespace either.
      expect((await upsert('alice', 'A', [doc('bob-8', 'project-yapa')])).body.results[0].error.code).toBe('task_namespace');
      // Unknown prefix for a non-task doc is fine (memory ids end in digits).
      expect((await upsert('alice', 'A', [doc('acme-auth-fix-1', 'project-yapa')])).body.results[0].status).toBe('inserted');
      expect((await db.adminPool.query("SELECT count(*)::int AS n FROM documents WHERE id LIKE 'bob-%'")).rows[0].n).toBe(0);
    });

    it('delete of another user\'s row is refused by RLS too', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('yapa.user', 'bob', true)");
        expect((await c.query("DELETE FROM documents WHERE id = 'acme-note-1'")).rowCount).toBe(0);
        await expect(c.query(
          `INSERT INTO documents (id, collection, content, embedding, metadata, origin_user, created_at, updated_at)
           VALUES ('spoof', 'customer-acme', 'x', $1::vector, '{}', 'alice', now(), now())`, [`[${unitVector(3).join(',')}]`],
        )).rejects.toThrow(/row-level security/);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    });

    it('local-only collections are rejected everywhere (403)', async () => {
      for (const coll of ['global', 'private-x', 'local-y']) {
        expect((await upsert('alice', 'A', [doc('lo-1', coll)])).body.results[0].error.code).toBe('local_only_collection');
        expect((await call('alice', 'A', 'PUT', '/v1/documents/lo-1', doc('lo-1', coll))).status).toBe(403);
        expect((await pullAll('alice', 'A', coll)).status).toBe(403);
        expect((await call('alice', 'A', 'POST', `/v1/collections/${coll}:similar`, { embedding: unitVector(1) })).status).toBe(403);
      }
      expect((await db.adminPool.query("SELECT count(*)::int AS n FROM documents WHERE id = 'lo-1'")).rows[0].n).toBe(0);
    });

    it('secrets -> 422 secret_detected (single) / item error (batch)', async () => {
      const key = ['AKIA', 'Z7Q4M2XKP9RTW3LB'].join('');
      const one = await call('alice', 'A', 'PUT', '/v1/documents/sec-1', { ...doc('sec-1', 'customer-acme'), content: `key ${key}` });
      expect([one.status, one.body.error.code, one.body.error.details.pattern]).toEqual([422, 'secret_detected', 'aws_access_key_id']);
      const batch = await upsert('alice', 'A', [{ ...doc('sec-2', 'customer-acme'), metadata: { type: 'memory', note: key } }, doc('ok-2', 'customer-acme')]);
      expect(batch.body.results.map((r: { status: string }) => r.status)).toEqual(['error', 'inserted']);
      expect(batch.body.results[0].error.code).toBe('secret_detected');
      expect(logs.join('\n')).not.toContain(key);
    });

    it('bad embeddings -> 422', async () => {
      const short = await call('alice', 'A', 'PUT', '/v1/documents/emb-1', { ...doc('emb-1', 'customer-acme'), embedding: [1, 0, 0] });
      expect([short.status, short.body.error.code]).toEqual([422, 'embedding_dimension']);
      const unnorm = await call('alice', 'A', 'PUT', '/v1/documents/emb-1', { ...doc('emb-1', 'customer-acme'), embedding: unitVector(2).map(x => x * 3) });
      expect([unnorm.status, unnorm.body.error.code]).toEqual([422, 'embedding_invalid']);
      const sim = await call('alice', 'A', 'POST', '/v1/collections/customer-acme:similar', { embedding: new Array(384).fill(0) });
      expect([sim.status, sim.body.error.code]).toEqual([422, 'embedding_invalid']);
    });

    it('device header is required for pull and upsert', async () => {
      expect((await call('alice', null, 'GET', '/v1/collections/customer-acme/documents')).status).toBe(400);
      expect((await call('alice', null, 'POST', '/v1/documents:batchUpsert', { documents: [] })).status).toBe(400);
    });
  });

  describe('tasks', () => {
    it('id_taken with suggested_id when the same task id has a different created_at', async () => {
      const t = { ...doc('alice-5', 'project-yapa'), metadata: { type: 'task', status: 'pending' }, created_at: NOW - 1000 };
      expect((await upsert('alice', 'A', [t])).body.results[0].status).toBe('inserted');
      expect((await call('alice', 'A', 'GET', '/v1/me/max-task-number')).body).toEqual({ max: 5 });
      expect((await call('bob', 'B', 'GET', '/v1/me/max-task-number')).body).toEqual({ max: 0 });
      // Same task, created_at within 1 s: an update (a teammate completing it is fine).
      expect((await upsert('bob', 'B', [{ ...t, created_at: NOW - 999, metadata: { type: 'task', status: 'completed' } }])).body.results[0].status).toBe('updated');
      const clash = await upsert('alice', 'C', [{ ...t, created_at: NOW - 200 }]);
      expect(clash.body.results[0]).toMatchObject({ status: 'error', error: { code: 'id_taken', remote_created_at: NOW - 1000, suggested_id: 'alice-6' } });
      const single = await call('alice', 'C', 'PUT', '/v1/documents/alice-5', { ...t, created_at: NOW - 200 });
      expect(single.status).toBe(409);
      expect((await call('alice', 'A', 'GET', '/v1/documents/alice-5/created-at')).body).toEqual({ created_at: NOW - 1000 });
      expect((await call('alice', 'A', 'GET', '/v1/documents/nope-1/created-at')).status).toBe(404);
    });
  });

  describe('pagination', () => {
    it('pages documents and deletions with a stable (synced_at, id) cursor, ties included', async () => {
      const ids = Array.from({ length: 7 }, (_, i) => `page-${i}`);
      await upsert('alice', 'A', ids.map(id => doc(id, 'project-pages')));
      // Force ties on synced_at so ordering falls back to id.
      await db.adminPool.query("UPDATE documents SET synced_at = '2026-01-01T00:00:00.123456Z' WHERE id IN ('page-2', 'page-3', 'page-4')");
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const q = cursor ? `?cursor=${cursor}&limit=3` : '?since=0&limit=3';
        const r = await call('bob', 'B', 'GET', `/v1/collections/project-pages/documents${q}`);
        expect(r.status).toBe(200);
        seen.push(...r.body.documents.map((d: { id: string }) => d.id));
        pages++;
        cursor = r.body.next_cursor;
        if (!r.body.has_more) break;
      }
      expect(seen.sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(7);
      expect(pages).toBe(3);

      // An exhausted cursor returns nothing new; later writes and deletions appear after it.
      expect((await call('bob', 'B', `GET`, `/v1/collections/project-pages/documents?cursor=${cursor}`)).body.documents).toEqual([]);
      await call('alice', 'A', 'POST', '/v1/documents:batchDelete', { ids: ['page-0', 'page-1', 'page-5', 'page-6'] });
      const dels: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await call('bob', 'B', 'GET', `/v1/collections/project-pages/documents?cursor=${cursor}&limit=3`);
        dels.push(...r.body.deletions.map((d: { id: string }) => d.id));
        cursor = r.body.next_cursor;
        if (!r.body.has_more) break;
      }
      expect(dels.sort()).toEqual(['page-0', 'page-1', 'page-5', 'page-6']);
      // A cursor from another collection is refused.
      expect((await call('bob', 'B', 'GET', `/v1/collections/customer-acme/documents?cursor=${cursor}`)).status).toBe(400);
    });
  });

  describe('pull limits and ranges', () => {
    it('orders same-second rows by microseconds, not whole seconds (no rows skipped)', async () => {
      await upsert('alice', 'A', [doc('ord-a', 'project-order'), doc('ord-b', 'project-order')]);
      // Same second; id order is the reverse of time order.
      await db.adminPool.query("UPDATE documents SET synced_at = '2026-01-01T00:00:00.900000Z' WHERE id = 'ord-a'");
      await db.adminPool.query("UPDATE documents SET synced_at = '2026-01-01T00:00:00.100000Z' WHERE id = 'ord-b'");
      const seen: string[] = [];
      let q = '?since=0&limit=1';
      for (let i = 0; i < 4; i++) {
        const r = await call('bob', 'B', 'GET', `/v1/collections/project-order/documents${q}`);
        seen.push(...r.body.documents.map((d: { id: string }) => d.id));
        if (!r.body.has_more) break;
        q = `?cursor=${r.body.next_cursor}&limit=1`;
      }
      expect(seen).toEqual(['ord-b', 'ord-a']);
    });

    it('caps each page by serialized bytes (YAPA_PULL_MAX_BYTES) and keeps paging correct', async () => {
      const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit ';
      const big = (i: number) => `${i} ${words.repeat(1100)}`.slice(0, 60_000); // ~60 KB each
      const ids = Array.from({ length: 5 }, (_, i) => `bigdoc-${i}`);
      const up = await upsert('alice', 'A', ids.map((id, i) => ({ ...doc(id, 'project-big'), content: big(i) })));
      expect(up.body.results.every((x: { status: string }) => x.status === 'inserted')).toBe(true);
      const small = createApp({
        pool,
        config: { similarityThreshold: 0.95, rateLimits: false, dailyWriteAlert: 20000, pullMaxBytes: 150_000 },
        verifier: new InsecureTestVerifier(),
      });
      const get = async (q: string) => {
        const r = await small.request(`/v1/collections/project-big/documents${q}`, { headers: { authorization: 'Bearer test:bob@example.com', 'x-yapa-device': 'B' } });
        const text = await r.text();
        expect(r.status).toBe(200);
        expect(Buffer.byteLength(text)).toBeLessThan(150_000 + 4096);
        return JSON.parse(text);
      };
      const seen: string[] = [];
      let q = '?since=0';
      let pages = 0;
      for (;;) {
        const body = await get(q);
        pages++;
        expect(body.documents.length).toBeGreaterThan(0);
        seen.push(...body.documents.map((d: { id: string }) => d.id));
        if (!body.has_more) break;
        q = `?cursor=${body.next_cursor}`;
        if (pages > 10) throw new Error('pagination did not terminate');
      }
      expect(seen).toEqual(ids); // all, in order, no duplicates
      expect(pages).toBe(3); // 2 + 2 + 1 (each doc ~68 KB with its embedding)
      // A single document over the budget still comes back alone.
      const tiny = createApp({
        pool, config: { similarityThreshold: 0.95, rateLimits: false, dailyWriteAlert: 20000, pullMaxBytes: 1000 },
        verifier: new InsecureTestVerifier(),
      });
      const one = await (await tiny.request('/v1/collections/project-big/documents?since=0', { headers: { authorization: 'Bearer test:bob@example.com', 'x-yapa-device': 'B' } })).json();
      expect(one.documents.map((d: { id: string }) => d.id)).toEqual(['bigdoc-0']);
      expect(one.has_more).toBe(true);
    });

    it('huge since and cursor values are 400 invalid_request, not 500', async () => {
      for (const since of ['1e300', '9223372036854775807', String(NOW + 3 * 86400)]) {
        const r = await call('bob', 'B', 'GET', `/v1/collections/customer-acme/documents?since=${since}`);
        expect(r.status, since).toBe(400);
        expect(r.body.error.code).toBe('invalid_request');
      }
      const cur = Buffer.from(JSON.stringify({ c: 'customer-acme', d: { t: '99999999999999999999', id: 'a' }, x: { t: '0', id: null } })).toString('base64url');
      const r = await call('bob', 'B', 'GET', `/v1/collections/customer-acme/documents?cursor=${cur}`);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_request');
      expect((await call('bob', 'B', 'GET', `/v1/collections/customer-acme/documents?since=${NOW + 3600}`)).status).toBe(200);
    });
  });

  describe('idempotency', () => {
    it('the same Idempotency-Key on PUTs to different ids does not replay', async () => {
      const { id: _id, ...body } = doc('x', 'customer-acme');
      const a = await call('alice', 'A', 'PUT', '/v1/documents/idem-put-a', body, { 'idempotency-key': 'k-put' });
      expect(a.body).toMatchObject({ id: 'idem-put-a', status: 'inserted' });
      const b = await call('alice', 'A', 'PUT', '/v1/documents/idem-put-b', body, { 'idempotency-key': 'k-put' });
      expect(b.headers.get('idempotent-replay')).toBeNull();
      expect(b.body).toMatchObject({ id: 'idem-put-b', status: 'inserted' });
      expect((await db.adminPool.query("SELECT count(*)::int AS n FROM documents WHERE id IN ('idem-put-a', 'idem-put-b')")).rows[0].n).toBe(2);
      // Same path + key + body still replays.
      const again = await call('alice', 'A', 'PUT', '/v1/documents/idem-put-a', body, { 'idempotency-key': 'k-put' });
      expect(again.headers.get('idempotent-replay')).toBe('true');
      expect(again.body).toEqual(a.body);
    });

    it('a retried batch with the same Idempotency-Key replays the response without re-auditing', async () => {
      const body = [doc('idem-1', 'customer-acme')];
      const first = await upsert('alice', 'A', body, { 'idempotency-key': 'k-123' });
      expect(first.body.results[0].status).toBe('inserted');
      const auditBefore = (await auditRows('idem-1')).length;
      const again = await upsert('alice', 'A', body, { 'idempotency-key': 'k-123' });
      expect(again.body).toEqual(first.body);
      expect(again.headers.get('idempotent-replay')).toBe('true');
      expect((await auditRows('idem-1')).length).toBe(auditBefore);
      // Without the key the upsert is still naturally idempotent.
      expect((await upsert('alice', 'A', body)).body.results[0].status).toBe('unchanged');
      // Same key, different body: refused.
      expect((await upsert('alice', 'A', [doc('idem-2', 'customer-acme')], { 'idempotency-key': 'k-123' })).status).toBe(400);
      // Keys are per user.
      expect((await upsert('bob', 'B', [doc('idem-3', 'customer-acme')], { 'idempotency-key': 'k-123' })).body.results[0].status).toBe('inserted');
    });
  });

  describe('lookups, similarity, related ids', () => {
    it('collections and owners', async () => {
      const cols = (await call('bob', 'B', 'GET', '/v1/collections')).body.collections as Array<{ name: string; count: number }>;
      expect(cols.find(c => c.name === 'customer-acme')!.count).toBeGreaterThan(0);
      expect(cols.every(c => !c.name.startsWith('private-') && c.name !== 'global')).toBe(true);
      expect((await call('bob', 'B', 'GET', '/v1/me/collections')).body.collections).toContain('customer-acme');
      const owners = (await call('bob', 'B', 'POST', '/v1/documents:owners', { ids: ['acme-note-1', 'nope'] })).body;
      expect(owners).toEqual({ owners: { 'acme-note-1': 'alice' }, created_at: { 'acme-note-1': NOW - 100 } });
    });

    it('similarity search and the upsert similar hint', async () => {
      const base = doc('sim-1', 'project-sim');
      await upsert('alice', 'A', [base]);
      const r = await call('bob', 'B', 'POST', '/v1/collections/project-sim:similar', { embedding: base.embedding, threshold: 0.2, limit: 50 });
      expect(r.body.matches[0]).toMatchObject({ id: 'sim-1' });
      expect(r.body.matches[0].similarity).toBeGreaterThan(0.99);
      const twin = await upsert('bob', 'B', [{ ...base, id: 'sim-2', content: 'near duplicate' }]);
      expect(twin.body.results[0].similar).toEqual([{ id: 'sim-1', similarity: expect.any(Number) }]);
    });

    it('related ids: set union, bumps synced_at, teammate allowed, audited as link', async () => {
      const before = (await db.adminPool.query("SELECT synced_at FROM documents WHERE id = 'sim-1'")).rows[0].synced_at;
      const r1 = await call('bob', 'B', 'POST', '/v1/documents/sim-1/related-ids', { add: ['sim-2', 'sim-2', 'sim-1'] });
      expect(r1.body).toEqual({ related_ids: ['sim-2'] });
      const r2 = await call('bob', 'B', 'POST', '/v1/documents/sim-1/related-ids', { add: ['sim-2', 'x-9'] });
      expect(r2.body).toEqual({ related_ids: ['sim-2', 'x-9'] });
      const row = (await db.adminPool.query("SELECT synced_at, last_editor FROM documents WHERE id = 'sim-1'")).rows[0];
      expect(row.synced_at.getTime()).toBeGreaterThan(before.getTime());
      expect(row.last_editor).toBe('alice');
      expect((await auditRows('sim-1')).filter(a => a.action === 'link')).toHaveLength(2);
      expect((await call('bob', 'B', 'POST', '/v1/documents/none-1/related-ids', { add: ['a'] })).status).toBe(404);
    });
  });
});
