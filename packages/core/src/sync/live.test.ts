/**
 * Opt-in live check of the core sync flow against a DEPLOYED remote that
 * implements YAPA Sync API v1 (docs/sync-api.md): the YAPA sync service or
 * any other implementation. This is also the conformance runner:
 *
 *   gcloud auth login
 *   npm run conformance -- https://<host>[/<prefix>]                  (repo root)
 *   YAPA_LIVE_SERVICE_URL=https://<host> npx vitest run src/sync/live.test.ts   (in packages/core)
 *
 * Skipped unless YAPA_LIVE_SERVICE_URL is set. Uses your Google ID token from
 * `gcloud auth print-identity-token` (or YAPA_SYNC_ID_TOKEN_CMD). Uses its own
 * temporary local stores, never your YAPA data.
 *
 * Writes only to a per-run collection project-yapa-it-<run>, only rows owned
 * by the signed-in user, and deletes every row it created afterwards (the
 * remote keeps its audit/deletions entries). Coordination cases release their
 * leases; the per-run counter row stays (no API removes counters), and the
 * task-id case consumes one of your task numbers (a gap in your ids).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setConfig, resetConfig, createConfig, getConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds, type VectorStore } from '../store/index.js';
import { HttpBackend, ServiceError } from './http-backend.js';
import { setSyncBackend, type LeaseAcquireResult } from './backend.js';
import { pushToRemote } from './push.js';
import { pullCollection } from './pull.js';
import { queueSyncDelete } from './deletes.js';

const URL_ = process.env.YAPA_LIVE_SERVICE_URL;
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const COL = `project-yapa-it-${RUN}`;
const NOW = Math.floor(Date.now() / 1000);

/** Coordination is optional for a remote: 404 not_found means "not implemented" (the client falls back). */
function notImplemented(e: unknown): boolean {
  return e instanceof ServiceError && e.status === 404 && e.code === 'not_found';
}

describe.skipIf(!URL_)('live sync remote (opt-in conformance)', () => {
  let dir: string;
  let backend: HttpBackend;
  const stores = new Map<string, VectorStore>();
  const created: string[] = [];

  function as(device: string) {
    setConfig({ ...createConfig({ ...process.env, YAPA_DEVICE_ID: `it-${device}-${RUN}`, YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: URL_, YAPA_SYNC_PUSH_DEBOUNCE_MS: '0' }), USERNAME: getConfig().USERNAME });
    if (!stores.has(device)) stores.set(device, createLocalStore(join(dir, device)));
    setStore(stores.get(device)!);
  }

  /** Remote owner of `id`, or undefined when the row does not exist. */
  async function ownerOf(id: string): Promise<string | undefined> {
    return (await backend.ownersByIds([id])).get(id)?.owner;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yapa-live-'));
    setConfig(createConfig({ ...process.env, YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: URL_ }));
    backend = new HttpBackend();
    setSyncBackend(backend);
    await backend.prepare(); // signs in; the remote's username becomes USERNAME
  }, 60_000);

  afterAll(async () => {
    try {
      if (created.length) await backend.delete(created, 'delete');
    } finally {
      setSyncBackend(undefined);
      resetStore();
      resetConfig();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('GET /v1/me names the signed-in user', async () => {
    const me = await backend.me(true);
    expect(me.username).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(me.email).toContain('@');
  });

  it('push, pull from a second device, delete, deletion feed, deletion applied', async () => {
    const id = `it-mem-${RUN}`;
    created.push(id);

    as('a');
    await getStore().getOrCreateCollection(COL);
    await getStore().addDocument(COL, id, `yapa live integration check ${RUN}`, { type: 'memory', created_at: NOW, updated_at: NOW, is_synced: false });
    const pushed = await pushToRemote();
    expect(pushed.errors).toBe(0);
    expect(pushed.rejected).toBe(0);
    const owners = await backend.ownersByIds([id]);
    expect(owners.get(id)).toEqual({ owner: getConfig().USERNAME, createdAt: NOW });
    expect((await backend.collectionsByIds([id])).get(id)).toBe(COL);

    as('b');
    const pulled = await pullCollection(COL, 0);
    expect(pulled.errors).toBe(0);
    const [copy] = await getDocumentsByIds(COL, [id]);
    expect(copy?.content).toBe(`yapa live integration check ${RUN}`);
    expect(copy?.metadata.origin_user).toBe(getConfig().USERNAME);
    expect(copy?.metadata.type).toBe('memory');

    as('a');
    await getStore().deleteDocument(COL, id);
    await queueSyncDelete(id, COL);
    expect((await pushToRemote()).deleted).toBe(1);
    expect(await ownerOf(id)).toBeUndefined();

    // The deletions feed carries the delete to a full pull from position 0.
    const page = await backend.pull(COL, { since: 0 });
    expect(page.deletions.map(d => d.id)).toContain(id);
    expect(page.documents.map(d => d.id)).not.toContain(id);

    as('b');
    const after = await pullCollection(COL, 0);
    expect(after.deleted).toBe(1);
    expect(await getDocumentsByIds(COL, [id])).toEqual([]);
  }, 120_000);

  it('leases: grant, conflict for a second session, held_by_other, release', async ctx => {
    const c = backend.coordination;
    const key = `it-lease-${RUN}`;
    const s1 = `it-s1-${RUN}`;
    const s2 = `it-s2-${RUN}`;
    let first: LeaseAcquireResult;
    try {
      first = await c.leaseAcquire({ collection: COL, key, session: s1, ttlSeconds: 60, title: 'conformance check' });
    } catch (e) {
      if (notImplemented(e)) return ctx.skip();
      throw e;
    }
    try {
      expect(first.granted).toBe(true);
      if (!first.granted) return;
      expect(first.lease).toMatchObject({ collection: COL, key, holder: { user: getConfig().USERNAME, session: s1 }, ttl_seconds: 60, expired: false });
      expect(first.lease.scope).toContain(`key:${key}`);

      const second = await c.leaseAcquire({ collection: COL, key, session: s2, ttlSeconds: 60 });
      expect(second.granted).toBe(false);
      if (!second.granted) expect(second.conflicts[0].lease.holder.session).toBe(s1);

      expect((await c.leaseList(COL)).leases.map(l => l.key)).toContain(key);
      expect((await c.leaseHeartbeat(COL, s1, [key])).renewed.map(l => l.key)).toEqual([key]);
      expect(await c.leaseRelease(COL, key, s2)).toMatchObject({ released: false, reason: 'held_by_other' });
    } finally {
      await c.leaseRelease(COL, key, s1).catch(() => undefined);
    }
    expect((await c.leaseList(COL)).leases.map(l => l.key)).not.toContain(key);
    expect(await c.leaseRelease(COL, key, s1)).toMatchObject({ released: false, reason: 'not_held' });
  }, 60_000);

  it('counters:next is strictly increasing and honors the floor', async ctx => {
    const c = backend.coordination;
    let a: number;
    try {
      a = await c.counterNext(COL, 'it-counter');
    } catch (e) {
      if (notImplemented(e)) return ctx.skip();
      throw e;
    }
    const b = await c.counterNext(COL, 'it-counter');
    expect(b).toBeGreaterThan(a);
    const floored = await c.counterNext(COL, 'it-counter', b + 10);
    expect(floored).toBeGreaterThan(b + 10);
  }, 60_000);

  it('task-ids:next returns <username>-<n> above the highest existing task number', async ctx => {
    let id: string;
    try {
      id = await backend.coordination.nextTaskId(0);
    } catch (e) {
      if (notImplemented(e)) return ctx.skip();
      throw e;
    }
    const me = getConfig().USERNAME;
    expect(id.startsWith(`${me}-`)).toBe(true);
    const n = Number(id.slice(me.length + 1));
    expect(Number.isInteger(n) && n > 0).toBe(true);
    expect(n).toBeGreaterThan(await backend.maxTaskNumber());
  }, 60_000);

  it('an unknown /v1 route answers 404 with the JSON error envelope (code not_found)', async () => {
    const err = await (backend as any).request('POST', '/v1/yapa-conformance-unknown-route', { body: {}, quiet: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ status: 404, code: 'not_found' });
  }, 60_000);
});
