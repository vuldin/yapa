/**
 * HttpBackend against a mock HTTP server (node:http): the header contract,
 * token caching and refresh, the 401 retry, every API call, and the push/pull
 * flows that depend on server features (pagination, deletions feed, id_taken,
 * secret rejection).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds } from '../store/index.js';
import { HttpBackend, IdTokenProvider, decodeJwtPayload, redactTokens } from './http-backend.js';
import { setSyncBackend, lastSyncError, getSyncBackend, syncBackendKind, syncUsernameNote } from './backend.js';
import { getConfig } from '../config.js';
import { getNextTaskId } from '../tasks/create.js';
import { pushToRemote, listRejectedDocs } from './push.js';
import { pullCollection, pullFromRemote } from './pull.js';
import { queueSyncDelete } from './deletes.js';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: any;
}

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
type Handler = (req: Seen) => Reply | Promise<Reply>;

let server: Server;
let base: string;
let handler: Handler = () => ({ status: 404, json: { error: { code: 'not_found', message: 'no handler' } } });
const seen: Seen[] = [];

/** An unsigned JWT-shaped token with the given exp (seconds). */
function jwt(exp: number, email = 'tester@example.com', n = 0): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp, email, n })}.c2lnbmF0dXJlLXBsYWNlaG9sZGVy`;
}

function tokens(list: string[] = [], now?: () => number) {
  let calls = 0;
  const provider = new IdTokenProvider(async () => {
    const t = list[Math.min(calls, list.length - 1)] ?? jwt(Math.floor(Date.now() / 1000) + 3600, 'tester@example.com', calls);
    calls++;
    return `${t}\n`;
  }, now);
  return { provider, calls: () => calls };
}

function backend(opts: { tokens?: IdTokenProvider; timeoutMs?: number } = {}) {
  return new HttpBackend({ baseUrl: base, tokens: opts.tokens ?? tokens().provider, device: () => 'dev-A', timeoutMs: opts.timeoutMs ?? 2000 });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, 'http://x');
    const s: Seen = { method: req.method!, path: decodeURIComponent(url.pathname), query: url.searchParams, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    seen.push(s);
    const r = await handler(s);
    res.writeHead(r.status ?? 200, { 'content-type': r.text !== undefined ? 'text/html' : 'application/json', ...(r.headers ?? {}) });
    res.end(r.text ?? JSON.stringify(r.json ?? {}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_DEVICE_ID: 'dev-A', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: base }));
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  resetConfig();
});

beforeEach(() => {
  seen.length = 0;
});

describe('header contract and auth', () => {
  it('sends the ID token as Bearer AND X-Yapa-Id-Token, plus the device; writes carry an Idempotency-Key', async () => {
    const t = jwt(Math.floor(Date.now() / 1000) + 3600);
    handler = () => ({ json: { results: [{ id: 'a', status: 'inserted', synced_at: 1, similar: [] }] } });
    await backend({ tokens: tokens([t]).provider }).upsertMany([{ id: 'a', collection: 'project-x', content: 'c', embedding: [1], metadata: {}, origin_user: 'tester', created_at: 1, updated_at: 1 }]);
    const [r] = seen;
    expect(r.headers.authorization).toBe(`Bearer ${t}`);
    expect(r.headers['x-yapa-id-token']).toBe(t);
    expect(r.headers['x-yapa-device']).toBe('dev-A');
    expect(r.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.documents[0]).not.toHaveProperty('origin_user'); // the server assigns ownership
  });

  it('caches the token in memory until ~5 minutes before exp, then mints a new one', async () => {
    let now = 1_000_000_000_000;
    const exp = now / 1000 + 3600;
    const tk = tokens([jwt(exp), jwt(exp + 3600)], () => now);
    handler = () => ({ json: { max: 3 } });
    const b = backend({ tokens: tk.provider });
    await b.maxTaskNumber();
    await b.maxTaskNumber();
    expect(tk.calls()).toBe(1);
    now += (3600 - 301) * 1000; // still more than 5 minutes left
    await b.maxTaskNumber();
    expect(tk.calls()).toBe(1);
    now += 2000; // inside the refresh margin
    await b.maxTaskNumber();
    expect(tk.calls()).toBe(2);
  });

  it('shares one token command run between concurrent requests', async () => {
    const tk = tokens();
    handler = () => ({ json: { max: 0 } });
    const b = backend({ tokens: tk.provider });
    await Promise.all([b.maxTaskNumber(), b.maxTaskNumber(), b.maxTaskNumber()]);
    expect(tk.calls()).toBe(1);
  });

  it('on 401 refreshes the token once and retries with the same Idempotency-Key', async () => {
    const t1 = jwt(Math.floor(Date.now() / 1000) + 3600, 'a@example.com', 1);
    const t2 = jwt(Math.floor(Date.now() / 1000) + 3600, 'a@example.com', 2);
    const tk = tokens([t1, t2]);
    handler = s => s.headers['x-yapa-id-token'] === t1
      ? { status: 401, json: { error: { code: 'unauthenticated', message: 'invalid or expired token' } } }
      : { json: { results: [], deleted: 2 } };
    expect(await backend({ tokens: tk.provider }).delete(['x', 'y'], 'delete')).toBe(2);
    expect(tk.calls()).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[0].headers['idempotency-key']).toBe(seen[1].headers['idempotency-key']);
  });

  it('a second 401 fails with a sign-in hint and never echoes the token', async () => {
    const t = jwt(Math.floor(Date.now() / 1000) + 3600);
    const tk = tokens([t]);
    handler = () => ({ status: 401, json: { error: { code: 'unauthenticated', message: `bad token ${t}` } } });
    const err = await backend({ tokens: tk.provider }).collections().catch(e => e);
    expect(err.message).toMatch(/gcloud auth login/);
    expect(err.message).not.toContain(t);
    expect(tk.calls()).toBe(2);
    expect(lastSyncError()?.message).toMatch(/gcloud auth login/);
  });

  it('explains a Cloud Run IAM 403 (HTML body, no API error code)', async () => {
    handler = () => ({ status: 403, text: '<html>Forbidden</html>' });
    await expect(backend().collections()).rejects.toThrow(/roles\/run\.invoker/);
  });

  it('explains not_member and surfaces rate limiting with Retry-After', async () => {
    handler = () => ({ status: 403, json: { error: { code: 'not_member', message: 'x' } } });
    await expect(backend().collections()).rejects.toThrow(/not mapped to a YAPA user/);
    handler = () => ({ status: 429, json: { error: { code: 'rate_limited', message: 'rate limit exceeded' } }, headers: { 'retry-after': '3' } });
    const err = await backend().collections().catch(e => e);
    expect(err.code).toBe('rate_limited');
    expect(err.details.retry_after).toBe(3);
  });

  it('fails fast on a hung service (timeout) and when the token command fails', async () => {
    handler = () => new Promise(resolve => setTimeout(() => resolve({ json: {} }), 1500));
    await expect(backend({ timeoutMs: 200 }).collections()).rejects.toThrow(/timed out after 200 ms/);
    const broken = new IdTokenProvider(async () => { throw new Error('gcloud: You do not currently have an active account selected.'); });
    const err = await backend({ tokens: broken }).collections().catch(e => e);
    expect(err.code).toBe('token_command');
  });

  it('decodes exp without verification and redacts JWT-like text', () => {
    const t = jwt(123, 'z@example.com');
    expect(decodeJwtPayload(t)).toMatchObject({ exp: 123, email: 'z@example.com' });
    expect(decodeJwtPayload('opaque')).toBeUndefined();
    expect(redactTokens(`x ${t} y`)).toBe('x <token> y');
  });
});

describe('every API call', () => {
  it('pull: since/limit/embeddings=false, cursor on later pages, maps deletions and has_more', async () => {
    handler = s => ({ json: { documents: [{ id: 'd1', collection: 'project-x', content: 'c', metadata: { type: 'memory' }, origin_user: 'mate', last_editor: 'mate', related_ids: [], created_at: 1, updated_at: 2, synced_at: 3 }], deletions: [{ id: 'gone', deleted_by: 'mate', deleted_at: 4 }], next_cursor: 'CUR', has_more: !s.query.get('cursor') } });
    const b = backend();
    const p1 = await b.pull('project-x', { since: 100, includeOwnDevice: true });
    expect(seen[0].path).toBe('/v1/collections/project-x/documents');
    expect(Object.fromEntries(seen[0].query)).toEqual({ since: '100', limit: '500', include_own_device: 'true', embeddings: 'false' });
    expect(p1).toMatchObject({ hasMore: true, nextCursor: 'CUR', deletions: [{ id: 'gone' }] });
    expect(p1.documents[0]).toMatchObject({ id: 'd1', origin_user: 'mate' });
    const p2 = await b.pull('project-x', { since: 100, cursor: 'CUR' });
    expect(seen[1].query.get('cursor')).toBe('CUR');
    expect(seen[1].query.has('since')).toBe(false);
    expect(p2.hasMore).toBe(false);
  });

  it('upsertMany: per-item outcomes (id_taken with suggested_id, permanent secret rejection, pending is success)', async () => {
    handler = () => ({ json: { results: [
      { id: 'a', status: 'inserted', synced_at: 1, similar: [{ id: 'b', similarity: 0.97 }] },
      { id: 'tester-5', status: 'error', error: { code: 'id_taken', message: 'taken', remote_created_at: 1, suggested_id: 'tester-41' } },
      { id: 'c', status: 'error', error: { code: 'secret_detected', message: 'content matches a secret pattern (aws)' } },
      { id: 'd', status: 'pending', synced_at: 1, similar: [] },
      { id: 'e', status: 'error', error: { code: 'unavailable', message: 'retry' } },
    ] } });
    const doc = (id: string) => ({ id, collection: 'project-x', content: id, embedding: [1], metadata: {}, origin_user: 'tester', created_at: 1, updated_at: 1 });
    const out = await backend().upsertMany(['a', 'tester-5', 'c', 'd', 'e'].map(doc));
    expect(seen[0].path).toBe('/v1/documents:batchUpsert');
    expect(seen[0].body.documents[0].embedding_model).toBe('Xenova/all-MiniLM-L6-v2:q8');
    expect(out[0]).toMatchObject({ ok: true, similar: [{ id: 'b' }] });
    expect(out[1]).toMatchObject({ ok: false, code: 'id_taken', suggestedId: 'tester-41', permanent: false });
    expect(out[2]).toMatchObject({ ok: false, code: 'secret_detected', permanent: true });
    expect(out[3]).toMatchObject({ ok: true, status: 'pending' });
    expect(out[4]).toMatchObject({ ok: false, code: 'unavailable', permanent: false });
  });

  it('upsertMany splits into batches of at most 50 docs', async () => {
    handler = s => ({ json: { results: s.body.documents.map((d: any) => ({ id: d.id, status: 'inserted', synced_at: 1, similar: [] })) } });
    const docs = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, collection: 'project-x', content: 'c', embedding: [1], metadata: {}, origin_user: 'tester', created_at: 1, updated_at: 1 }));
    const out = await backend().upsertMany(docs);
    expect(seen.map(s => s.body.documents.length)).toEqual([50, 50, 20]);
    expect(out.map(o => o.id)).toEqual(docs.map(d => d.id));
    expect(new Set(seen.map(s => s.headers['idempotency-key'])).size).toBe(3);
  });

  it('delete: reason delete/retract, 500 ids per request', async () => {
    handler = s => ({ json: { results: [], deleted: s.body.ids.length } });
    const ids = Array.from({ length: 501 }, (_, i) => `x${i}`);
    expect(await backend().delete(ids, 'retract')).toBe(501);
    expect(seen.map(s => [s.path, s.body.ids.length, s.body.reason])).toEqual([['/v1/documents:batchDelete', 500, 'retract'], ['/v1/documents:batchDelete', 1, 'retract']]);
  });

  it('lookups: collections, me/collections, by-ids, owners (+created_at), created-at (404 = undefined), max task number', async () => {
    handler = s => {
      switch (`${s.method} ${s.path}`) {
        case 'GET /v1/collections': return { json: { collections: [{ name: 'project-x', count: 2 }] } };
        case 'GET /v1/me/collections': return { json: { collections: ['project-x'] } };
        case 'POST /v1/documents:collections': return { json: { collections: { a: 'project-x' } } };
        case 'POST /v1/documents:owners': return { json: { owners: { a: 'tester' }, created_at: { a: 1700 } } };
        case 'GET /v1/documents/a b/created-at': return { json: { created_at: 1800 } };
        case 'GET /v1/me/max-task-number': return { json: { max: 340 } };
        default: return { status: 404, json: { error: { code: 'not_found', message: 'document not found' } } };
      }
    };
    const b = backend();
    expect(await b.collections()).toEqual([{ name: 'project-x', count: 2 }]);
    expect(await b.collectionsForUser()).toEqual(['project-x']);
    expect(await b.collectionsByIds(['a', 'z'])).toEqual(new Map([['a', 'project-x']]));
    expect(await b.ownersByIds(['a'])).toEqual(new Map([['a', { owner: 'tester', createdAt: 1700 }]]));
    expect(await b.createdAt('a b')).toBe(1800);
    expect(await b.createdAt('missing')).toBeUndefined();
    expect(await b.maxTaskNumber()).toBe(340);
    expect(seen.find(s => s.path === '/v1/documents:owners')!.body).toEqual({ ids: ['a'] });
  });

  it('similar, related-ids, health and describe (signed-in identity from /v1/me)', async () => {
    handler = s => {
      if (s.path === '/v1/collections/project-x:similar') return { json: { matches: [{ id: 'm', similarity: 0.99 }] } };
      if (s.path === '/v1/documents/a/related-ids') return { json: { related_ids: s.body.add } };
      if (s.path === '/v1/health') return { json: { ok: true } };
      if (s.path === '/v1/me') return { json: { username: 'someone', email: 'someone@example.com', limits: {} } };
      return { status: 404, json: {} };
    };
    const b = backend();
    expect(await b.similar('project-x', [1, 0], 0.9)).toEqual([{ id: 'm', similarity: 0.99 }]);
    expect(seen[0].body).toEqual({ embedding: [1, 0], threshold: 0.9, limit: 5 });
    await b.addRelatedIds('a', ['b']);
    expect(seen[1].body).toEqual({ add: ['b'] });
    expect(await b.health()).toEqual({ ok: true });
    const lines = await b.describe();
    expect(lines).toEqual(expect.arrayContaining(['Backend: YAPA sync service', `Service: ${base}`, 'Signed in as: someone (someone@example.com)']));
    expect(lines).toContain("Username: using 'someone' from your Google account (the username option 'tester' is informational with the sync service)");
    setSyncBackend(undefined); // forget the learned identity
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_DEVICE_ID: 'dev-A', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: base }));
  });

  it('health reports the error instead of throwing', async () => {
    handler = () => ({ status: 503, json: { error: { code: 'unavailable', message: 'db down' } } });
    const h = await backend().health();
    expect(h.ok).toBe(false);
    expect(h.error).toMatch(/temporarily unavailable/);
  });
});

/**
 * A tiny stateful stand-in for the service: enough of upsert, pull (with a
 * 2-row page size and a deletions feed), delete and lookups to drive the real
 * push/pull code.
 */
class FakeService {
  docs = new Map<string, any>();
  deletions: Array<{ id: string; collection: string; deleted_by: string; deleted_at: number; seq: number }> = [];
  seq = 0;
  pageSize = 2;
  /** Ids whose content the server refuses as a secret. */
  secretWords = ['AKIAFAKEFAKEFAKEFAKE'];
  upserts: string[] = [];

  handle = (s: Seen): Reply => {
    const me = 'tester';
    const route = `${s.method} ${s.path}`;
    if (route === 'POST /v1/documents:batchUpsert') {
      const results = s.body.documents.map((d: any) => {
        this.upserts.push(d.id);
        if (this.secretWords.some(w => d.content.includes(w))) return { id: d.id, status: 'error', error: { code: 'secret_detected', message: 'content matches a secret pattern (aws_access_key)' } };
        if (d.embedding.length !== 384) return { id: d.id, status: 'error', error: { code: 'embedding_dimension', message: 'bad dims' } };
        const cur = this.docs.get(d.id);
        if (cur && d.metadata.type === 'task' && Math.abs(cur.created_at - d.created_at) > 1) {
          const max = Math.max(0, ...[...this.docs.keys()].map(k => Number(/^tester-(\d+)$/.exec(k)?.[1] ?? 0)));
          return { id: d.id, status: 'error', error: { code: 'id_taken', message: 'taken', suggested_id: `${me}-${max + 1}` } };
        }
        this.docs.set(d.id, { ...d, origin_user: cur?.origin_user ?? me, related_ids: cur?.related_ids ?? [], seq: ++this.seq, device: s.headers['x-yapa-device'] });
        return { id: d.id, status: cur ? 'updated' : 'inserted', synced_at: this.seq, similar: [] };
      });
      return { json: { results } };
    }
    if (route === 'POST /v1/documents:batchDelete') {
      let deleted = 0;
      for (const id of s.body.ids) {
        const d = this.docs.get(id);
        if (!d || d.origin_user !== me) continue;
        this.docs.delete(id);
        this.deletions.push({ id, collection: d.collection, deleted_by: me, deleted_at: 0, seq: ++this.seq });
        deleted++;
      }
      return { json: { results: [], deleted } };
    }
    const pull = /^GET \/v1\/collections\/([^/]+)\/documents$/.exec(route);
    if (pull) {
      const c = pull[1];
      const cur = s.query.get('cursor') ? JSON.parse(s.query.get('cursor')!) : { d: 0, x: 0 };
      const device = s.headers['x-yapa-device'];
      const own = s.query.get('include_own_device') === 'true';
      const docs = [...this.docs.values()].filter(d => d.collection === c && d.seq > cur.d && (own || d.device !== device)).sort((a, b) => a.seq - b.seq);
      const dels = this.deletions.filter(d => d.collection === c && d.seq > cur.x).sort((a, b) => a.seq - b.seq);
      const page = docs.slice(0, this.pageSize);
      const dpage = dels.slice(0, this.pageSize);
      const next = { d: page.at(-1)?.seq ?? cur.d, x: dpage.at(-1)?.seq ?? cur.x };
      return { json: {
        documents: page.map(d => ({ id: d.id, collection: d.collection, content: d.content, metadata: d.metadata, origin_user: d.origin_user, last_editor: d.origin_user, related_ids: d.related_ids, created_at: d.created_at, updated_at: d.updated_at, synced_at: d.seq })),
        deletions: dpage.map(({ id, deleted_by, deleted_at }) => ({ id, deleted_by, deleted_at })),
        next_cursor: JSON.stringify(next),
        has_more: docs.length > page.length || dels.length > dpage.length,
      } };
    }
    if (route === 'POST /v1/documents:owners') {
      const ids: string[] = s.body.ids.filter((id: string) => this.docs.has(id));
      return { json: { owners: Object.fromEntries(ids.map(id => [id, this.docs.get(id).origin_user])), created_at: Object.fromEntries(ids.map(id => [id, this.docs.get(id).created_at])) } };
    }
    if (route === 'POST /v1/documents:collections') {
      const ids: string[] = s.body.ids.filter((id: string) => this.docs.has(id));
      return { json: { collections: Object.fromEntries(ids.map(id => [id, this.docs.get(id).collection])) } };
    }
    if (route === 'GET /v1/me/collections') return { json: { collections: [] } };
    if (route === 'GET /v1/me/max-task-number') return { json: { max: 0 } };
    return { status: 404, json: { error: { code: 'not_found', message: route } } };
  };

  /** A teammate's row, written from another device. */
  putTeammate(id: string, collection: string, content: string, t = 1_800_000_000) {
    this.docs.set(id, { id, collection, content, embedding: [], metadata: { type: 'memory' }, origin_user: 'mate', related_ids: [], created_at: t, updated_at: t, seq: ++this.seq, device: 'dev-mate' });
  }

  deleteAs(id: string, who: string) {
    const d = this.docs.get(id);
    this.docs.delete(id);
    this.deletions.push({ id, collection: d.collection, deleted_by: who, deleted_at: 1_800_000_100, seq: ++this.seq });
  }
}

describe('push and pull through the service', () => {
  let dir: string;
  let fake: FakeService;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yapa-http-flow-'));
    setStore(createLocalStore(dir));
  });

  afterAll(async () => {
    setSyncBackend(undefined);
    resetStore();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fake = new FakeService();
    handler = fake.handle;
    setSyncBackend(backend());
  });

  it('pull pages with the cursor until has_more is false', async () => {
    for (let i = 0; i < 5; i++) fake.putTeammate(`page-${i}`, 'project-pages', `teammate note number ${i}`);
    const stats = await pullCollection('project-pages', 0);
    expect(stats.pulled).toBe(5);
    expect(seen.filter(s => s.path.endsWith('/documents')).length).toBe(3); // 2 + 2 + 1
    expect((await getDocumentsByIds('project-pages', ['page-0', 'page-4'])).length).toBe(2);
  });

  it('applies the deletions feed: drops clean copies, keeps (and reports) dirty ones', async () => {
    fake.putTeammate('del-clean', 'project-dels', 'a note that gets deleted');
    fake.putTeammate('del-dirty', 'project-dels', 'a note edited here before the delete');
    await pullCollection('project-dels', 0);
    const [dirty] = await getDocumentsByIds('project-dels', ['del-dirty']);
    await getStore().addDocument('project-dels', 'del-dirty', 'my local edit', { ...dirty.metadata, is_synced: false });

    fake.deleteAs('del-clean', 'mate');
    fake.deleteAs('del-dirty', 'mate');
    const stats = await pullCollection('project-dels', 0);
    expect(stats.deleted).toBe(1);
    expect(stats.keptDirty).toBe(1);
    expect(await getDocumentsByIds('project-dels', ['del-clean'])).toEqual([]);
    expect((await getDocumentsByIds('project-dels', ['del-dirty']))[0].content).toBe('my local edit');
  });

  it('a delete and re-create of the same id in one pull keeps the live row', async () => {
    fake.putTeammate('re-1', 'project-re', 'first version');
    await pullCollection('project-re', 0);
    fake.deleteAs('re-1', 'mate');
    fake.putTeammate('re-1', 'project-re', 'second version', 1_800_000_500);
    await pullCollection('project-re', 0);
    expect((await getDocumentsByIds('project-re', ['re-1']))[0]?.content).toBe('second version');
  });

  it('push: id_taken renames the task locally to the suggested id and pushes it again', async () => {
    fake.docs.set('tester-5', { id: 'tester-5', collection: 'project-tasks', content: 'someone else', metadata: { type: 'task' }, origin_user: 'tester', related_ids: [], created_at: 1_700_000_000, updated_at: 1_700_000_000, seq: ++fake.seq, device: 'dev-B' });
    fake.docs.set('tester-40', { id: 'tester-40', collection: 'project-tasks', content: 'x', metadata: { type: 'task' }, origin_user: 'tester', related_ids: [], created_at: 1_700_000_000, updated_at: 1_700_000_000, seq: ++fake.seq, device: 'dev-B' });
    await getStore().createCollection('project-tasks');
    await getStore().addDocument('project-tasks', 'tester-5', 'my new task after a wipe', { type: 'task', id: 'tester-5', created_at: 1_900_000_000, updated_at: 1_900_000_000, is_synced: false });

    const stats = await pushToRemote();
    expect(stats.renamed).toBe(1);
    expect(fake.upserts.filter(id => id.startsWith('tester-'))).toEqual(['tester-5', 'tester-41']);
    expect(fake.docs.get('tester-5').content).toBe('someone else');
    expect(await getDocumentsByIds('project-tasks', ['tester-5'])).toEqual([]);
    const [renamed] = await getDocumentsByIds('project-tasks', ['tester-41']);
    expect(renamed.metadata).toMatchObject({ id: 'tester-41', rekeyed_from: 'tester-5', is_synced: true });
  });

  it('push: a secret is refused, kept local and unsynced, not resent until it changes', async () => {
    await getStore().createCollection('project-secrets');
    await getStore().addDocument('project-secrets', 'sec-1', 'the key is AKIAFAKEFAKEFAKEFAKE', { type: 'memory', created_at: 1_900_000_000, is_synced: false });

    const first = await pushToRemote();
    expect(first.rejected).toBe(1);
    const [kept] = await getDocumentsByIds('project-secrets', ['sec-1']);
    expect(kept.metadata).toMatchObject({ is_synced: false, sync_rejected: 'secret_detected' });
    expect(await listRejectedDocs()).toEqual([{ collection: 'project-secrets', id: 'sec-1', code: 'secret_detected' }]);

    fake.upserts.length = 0;
    const second = await pushToRemote();
    expect(fake.upserts).not.toContain('sec-1');
    expect(second.errors).toBe(0);

    await getStore().addDocument('project-secrets', 'sec-1', 'the key lives in the vault now', { ...kept.metadata, is_synced: false });
    const third = await pushToRemote();
    expect(fake.upserts).toContain('sec-1');
    expect(third.rejected).toBe(0);
    const [synced] = await getDocumentsByIds('project-secrets', ['sec-1']);
    expect(synced.metadata.is_synced).toBe(true);
    expect(synced.metadata.sync_rejected).toBeUndefined();
    expect(await listRejectedDocs()).toEqual([]);
  });

  it('push: queued deletes go out as reason "delete"; a private copy of my doc is retracted with reason "retract"', async () => {
    await getStore().createCollection('project-own');
    await getStore().addDocument('project-own', 'own-1', 'mine', { type: 'memory', created_at: 1_900_000_000, is_synced: false });
    await pushToRemote();
    await queueSyncDelete('own-1', 'project-own');
    await pushToRemote();
    expect(seen.filter(s => s.path === '/v1/documents:batchDelete').map(s => s.body)).toEqual([{ ids: ['own-1'], reason: 'delete' }]);

    await getStore().addDocument('project-own', 'own-2', 'mine too', { type: 'memory', created_at: 1_900_000_000, is_synced: false });
    await pushToRemote();
    await getStore().createCollection('private-mine');
    await getStore().addDocument('private-mine', 'own-2', 'mine too', { type: 'memory', created_at: 1_900_000_000, is_synced: true });
    seen.length = 0;
    const stats = await pushToRemote();
    expect(stats.retracted).toBe(1);
    expect(seen.filter(s => s.path === '/v1/documents:batchDelete').map(s => s.body)).toEqual([{ ids: ['own-2'], reason: 'retract' }]);
    expect(fake.docs.has('own-2')).toBe(false);
  });

  it('an auth failure stops the cycle early, does not advance the pull point, and is reported', async () => {
    handler = () => ({ status: 401, json: { error: { code: 'unauthenticated', message: 'nope' } } });
    await getStore().createCollection('project-auth');
    const { getSyncPullTimestamp, updateSyncPullTimestamp } = await import('./sentinel.js');
    await updateSyncPullTimestamp(1_900_000_000);
    const stats = await pullFromRemote();
    expect(stats.errors).toBeGreaterThan(0);
    expect(await getSyncPullTimestamp()).toBe(1_900_000_000);
    // /v1/me and one collection tried (each a 401 plus its retry), then the cycle stopped.
    expect(seen.length).toBeLessThanOrEqual(6);
    expect(lastSyncError()?.message).toMatch(/gcloud auth login/);
  });
});

describe('backend selection', () => {
  it('the service URL wins over a database URL; neither means no backend', async () => {
    expect(syncBackendKind(createConfig({ YAPA_SYNC_SERVICE_URL: 'https://svc.example', YAPA_SYNC_DATABASE_URL: 'postgres://x' }))).toBe('service');
    expect(syncBackendKind(createConfig({ YAPA_SYNC_DATABASE_URL: 'postgres://x' }))).toBe('postgres');
    expect(syncBackendKind(createConfig({}))).toBeUndefined();
    setSyncBackend(undefined);
    const prev = getConfig();
    setConfig(createConfig({ YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: 'https://svc.example/', YAPA_SYNC_DATABASE_URL: 'postgres://u:p@h/db' }));
    const b = await getSyncBackend();
    expect(b?.kind).toBe('service');
    expect(b?.target).toBe('https://svc.example');
    setConfig(prev);
  });
});

describe('username comes from the service (GET /v1/me)', () => {
  let dir: string;
  let meCalls = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yapa-http-user-'));
  });

  afterAll(async () => {
    setSyncBackend(undefined);
    resetStore();
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_DEVICE_ID: 'dev-A', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: base }));
    await rm(dir, { recursive: true, force: true });
  });

  it('task ids, origin_user and status use the server username; the configured one is informational', async () => {
    setConfig(createConfig({ YAPA_USERNAME: 'dana', YAPA_DEVICE_ID: 'dev-A', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: base }));
    setStore(createLocalStore(dir));
    const fake = new FakeService();
    handler = s => {
      if (s.path === '/v1/me') { meCalls++; return { json: { username: 'dana-smith', email: 'dana.smith@example.com', limits: {} } }; }
      if (s.path === '/v1/me/max-task-number') return { json: { max: 7 } };
      return fake.handle(s);
    };
    const tk = tokens();
    setSyncBackend(backend({ tokens: tk.provider }));

    expect(await getNextTaskId()).toBe('dana-smith-8');
    expect(getConfig().USERNAME).toBe('dana-smith');
    expect(syncUsernameNote()).toMatch(/using 'dana-smith' from your Google account/);

    // Cached per process: more calls do not re-ask /v1/me until the token is re-minted.
    await getNextTaskId();
    expect(meCalls).toBe(1);

    // A host re-installing its config with the configured name is corrected on the next sync call.
    setConfig({ ...getConfig(), USERNAME: 'dana' });
    await getSyncBackend();
    expect(getConfig().USERNAME).toBe('dana-smith');
  });

  it('id_taken renames to the server username prefix', async () => {
    const fake = new FakeService();
    handler = s => {
      if (s.path === '/v1/me') return { json: { username: 'dana-smith', email: 'dana.smith@example.com', limits: {} } };
      if (s.path === '/v1/documents:batchUpsert') {
        return { json: { results: s.body.documents.map((d: any) => d.id === 'dana-smith-8'
          ? { id: d.id, status: 'error', error: { code: 'id_taken', message: 'taken', suggested_id: 'dana-smith-20' } }
          : { id: d.id, status: 'inserted', synced_at: 1, similar: [] }) } };
      }
      return fake.handle(s);
    };
    await getStore().createCollection('project-dana');
    await getStore().addDocument('project-dana', 'dana-smith-8', 'a task', { type: 'task', id: 'dana-smith-8', created_at: 1_900_000_000, is_synced: false });
    const stats = await pushToRemote();
    expect(stats.renamed).toBe(1);
    expect((await getDocumentsByIds('project-dana', ['dana-smith-20'])).length).toBe(1);
  });
});
