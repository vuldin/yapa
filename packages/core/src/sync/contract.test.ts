/**
 * Backend contract: the same sync scenarios against both SyncBackend
 * implementations, driving the real push/pull code with one local store per
 * device:
 *
 * - PostgresBackend over a fresh database with the core schema (schema.ts)
 * - HttpBackend over the in-process @yapa/service app (YAPA_AUTH_MODE
 *   insecure-test verifier) on a fresh database with infra/cloudsql/sql
 *   00-04 applied (RLS in force; see packages/service/test/pgsetup.ts)
 *
 * Skipped unless YAPA_CONTRACT_DB_URL names a superuser connection to a
 * throwaway pgvector server; both databases are created and dropped here:
 *
 *   docker run -d --rm --name yapa-ct -e POSTGRES_PASSWORD=ct -p 127.0.0.1:55433:5432 pgvector/pgvector:pg17
 *   YAPA_CONTRACT_DB_URL=postgres://postgres:ct@127.0.0.1:55433/postgres npx vitest run src/sync/contract.test.ts
 *   docker rm -f yapa-ct
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds, type VectorStore } from '../store/index.js';
import { generateEmbedding } from '../embeddings.js';
import { setSyncBackend, type SyncBackend } from './backend.js';
import { HttpBackend, IdTokenProvider } from './http-backend.js';
import { PostgresBackend } from './postgres-backend.js';
import { closePool } from './postgres.js';
import { pushToRemote } from './push.js';
import { pullCollection } from './pull.js';
import { queueSyncDelete } from './deletes.js';

const ADMIN_URL = process.env.YAPA_CONTRACT_DB_URL;
const NOW = Math.floor(Date.now() / 1000);
const COL = 'project-contract';

interface Harness {
  name: 'postgres' | 'service';
  /** Make `user` on `device` the current identity (config, store, backend). */
  as(user: string, device: string): void;
  teardown(): Promise<void>;
}

async function postgresHarness(dir: string): Promise<Harness> {
  const dbName = `yapa_ct_${randomBytes(4).toString('hex')}`;
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  await root.end();
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${dbName}`;
  const stores = new Map<string, VectorStore>();
  const backend = new PostgresBackend();
  const h: Harness = {
    name: 'postgres',
    as(user, device) {
      setConfig(createConfig({ YAPA_USERNAME: user, YAPA_DEVICE_ID: device, YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_DATABASE_URL: url.toString(), YAPA_SYNC_PUSH_DEBOUNCE_MS: '0' }));
      if (!stores.has(device)) stores.set(device, createLocalStore(join(dir, `pg-${device}`)));
      setStore(stores.get(device)!);
      setSyncBackend(backend);
    },
    async teardown() {
      await closePool();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.end();
    },
  };
  h.as('alice', 'pg-setup');
  await backend.prepare();
  return h;
}

async function serviceHarness(dir: string): Promise<Harness> {
  // Service sources, run in-process (test-only cross-package import).
  const { createItDb } = await import('../../../service/test/pgsetup.js');
  const { createApp } = await import('../../../service/src/app.js');
  const { InsecureTestVerifier } = await import('../../../service/src/auth.js');
  const { setLogSink } = await import('../../../service/src/log.js');
  const { serve } = await import('@hono/node-server');

  const restoreLog = setLogSink(() => undefined);
  const db = await createItDb(ADMIN_URL!);
  await db.adminPool.query(`INSERT INTO users (username, email, active) VALUES ('alice', 'alice@example.com', true), ('bob', 'bob@example.com', true)`);
  const pool = new pg.Pool({ connectionString: db.runtimeUrl, max: 4, statement_timeout: 5000 });
  const app = createApp({ pool, config: { similarityThreshold: 0.95, rateLimits: false, dailyWriteAlert: 20000 }, verifier: new InsecureTestVerifier() });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>(resolve => (server.listening ? resolve() : server.once('listening', () => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const stores = new Map<string, VectorStore>();
  const backends = new Map<string, HttpBackend>();
  return {
    name: 'service',
    as(user, device) {
      setConfig(createConfig({ YAPA_USERNAME: user, YAPA_DEVICE_ID: device, YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: base, YAPA_SYNC_PUSH_DEBOUNCE_MS: '0', YAPA_SYNC_ID_TOKEN_CACHE: 'off' }));
      if (!stores.has(device)) stores.set(device, createLocalStore(join(dir, `svc-${device}`)));
      setStore(stores.get(device)!);
      if (!backends.has(user)) {
        backends.set(user, new HttpBackend({ baseUrl: base, tokens: new IdTokenProvider(async () => `test:${user}@example.com`) }));
      }
      setSyncBackend(backends.get(user)!);
    },
    async teardown() {
      await new Promise(resolve => server.close(resolve));
      await pool.end();
      await db.drop();
      restoreLog();
    },
  };
}

async function backendNow(): Promise<SyncBackend> {
  const { getSyncBackend } = await import('./backend.js');
  return (await getSyncBackend())!;
}

async function write(id: string, content: string, metadata: Record<string, any> = {}, collection = COL): Promise<void> {
  await getStore().getOrCreateCollection(collection);
  await getStore().addDocument(collection, id, content, { type: 'memory', created_at: NOW - 100, updated_at: NOW - 100, is_synced: false, ...metadata });
}

const has = async (id: string, collection = COL) => (await getDocumentsByIds(collection, [id]).catch(() => [])).length === 1;

for (const kind of ['postgres', 'service'] as const) {
  describe.skipIf(!ADMIN_URL)(`sync contract: ${kind} backend`, () => {
    let dir: string;
    let h: Harness;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), `yapa-contract-${kind}-`));
      h = kind === 'postgres' ? await postgresHarness(dir) : await serviceHarness(dir);
    }, 120_000);

    afterAll(async () => {
      setSyncBackend(undefined);
      await h?.teardown();
      resetStore();
      resetConfig();
      rmSync(dir, { recursive: true, force: true });
    });

    it('push from one device reaches the same user\'s other device and a teammate; no echo on the writer', async () => {
      h.as('alice', 'a1');
      await write('ct-mem-1', 'the contract deploy uses blue-green rollouts');
      const pushed = await pushToRemote();
      expect(pushed.errors).toBe(0);
      expect(pushed.pushed + pushed.linked).toBe(1);
      expect((await getDocumentsByIds(COL, ['ct-mem-1']))[0].metadata.is_synced).toBe(true);

      expect((await pullCollection(COL, 0)).pulled).toBe(0); // own device: echo skipped

      h.as('alice', 'a2');
      expect((await pullCollection(COL, 0)).pulled).toBe(1);
      h.as('bob', 'b1');
      expect((await pullCollection(COL, 0)).pulled).toBe(1);
      const [doc] = await getDocumentsByIds(COL, ['ct-mem-1']);
      expect(doc.metadata.origin_user).toBe('alice');
    });

    it('a teammate edit wins on a clean copy', async () => {
      h.as('bob', 'b1');
      const [doc] = await getDocumentsByIds(COL, ['ct-mem-1']);
      await getStore().addDocument(COL, 'ct-mem-1', 'the contract deploy uses canary rollouts', { ...doc.metadata, updated_at: NOW - 10, is_synced: false });
      expect((await pushToRemote()).errors).toBe(0);
      h.as('alice', 'a1');
      expect((await pullCollection(COL, 0)).updated).toBe(1);
      expect((await getDocumentsByIds(COL, ['ct-mem-1']))[0].content).toBe('the contract deploy uses canary rollouts');
    });

    it('lookups: collections with counts, own collections, owners + created_at, created-at, collections by id, similarity', async () => {
      h.as('alice', 'a1');
      const b = await backendNow();
      expect(await b.collections()).toEqual(expect.arrayContaining([{ name: COL, count: 1 }]));
      expect(await b.collectionsForUser()).toContain(COL);
      const owners = await b.ownersByIds(['ct-mem-1', 'nope']);
      expect(owners.get('ct-mem-1')).toEqual({ owner: 'alice', createdAt: NOW - 100 });
      expect(owners.has('nope')).toBe(false);
      expect(await b.createdAt('ct-mem-1')).toBe(NOW - 100);
      expect(await b.createdAt('nope')).toBeUndefined();
      expect(await b.collectionsByIds(['ct-mem-1'])).toEqual(new Map([['ct-mem-1', COL]]));
      const emb = await generateEmbedding('the contract deploy uses canary rollouts');
      expect((await b.similar(COL, emb, 0.9)).map(m => m.id)).toContain('ct-mem-1');
      expect((await b.health()).ok).toBe(true);
    });

    it('task id collision: a different task with a taken id is renamed locally, the remote task is untouched', async () => {
      h.as('alice', 'a1');
      await write('alice-1', 'original task one', { type: 'task', id: 'alice-1', created_at: NOW - 1000, updated_at: NOW - 1000 });
      expect((await pushToRemote()).errors).toBe(0);

      h.as('alice', 'a3'); // a wiped store mints alice-1 again
      await write('alice-1', 'a different task', { type: 'task', id: 'alice-1', created_at: NOW - 50, updated_at: NOW - 50 });
      const stats = await pushToRemote();
      expect(stats.errors).toBe(0);
      expect(stats.renamed).toBe(1);
      expect(await has('alice-1')).toBe(false);
      expect(await has('alice-2')).toBe(true);
      const b = await backendNow();
      expect(await b.createdAt('alice-1')).toBe(NOW - 1000);
      expect(await b.createdAt('alice-2')).toBe(NOW - 50);
      expect(await b.maxTaskNumber()).toBe(2);
    });

    it('delete: the owner\'s delete removes the shared row; the deletions feed drops clean copies elsewhere', async () => {
      h.as('alice', 'a1');
      await write('ct-mem-2', 'a note that will be deleted soon');
      await pushToRemote();
      h.as('bob', 'b1');
      await pullCollection(COL, 0);
      expect(await has('ct-mem-2')).toBe(true);

      h.as('alice', 'a1');
      await getStore().deleteDocument(COL, 'ct-mem-2');
      await queueSyncDelete('ct-mem-2', COL);
      expect((await pushToRemote()).deleted).toBe(1);
      expect(await (await backendNow()).createdAt('ct-mem-2')).toBeUndefined();

      h.as('bob', 'b1');
      const stats = await pullCollection(COL, 0);
      if ((await backendNow()).capabilities.deletionsFeed) {
        expect(stats.deleted).toBe(1);
        expect(await has('ct-mem-2')).toBe(false);
      } else {
        expect(await has('ct-mem-2')).toBe(true); // Postgres: no deletions feed
      }
    });

    it('a teammate cannot delete my row', async () => {
      h.as('bob', 'b1');
      expect(await (await backendNow()).delete(['ct-mem-1'], 'delete')).toBe(0);
      expect(await (await backendNow()).createdAt('ct-mem-1')).toBe(NOW - 100);
    });

    it('retraction: my doc moved into a private collection loses its shared copy', async () => {
      h.as('alice', 'a1');
      await write('ct-mem-3', 'soon to be private');
      await pushToRemote();
      await getStore().deleteDocument(COL, 'ct-mem-3');
      await write('ct-mem-3', 'soon to be private', { is_synced: true }, 'private-alice');
      const stats = await pushToRemote();
      expect(stats.retracted).toBe(1);
      expect(await (await backendNow()).createdAt('ct-mem-3')).toBeUndefined();
    });

    it('a doc the remote refuses stays local and unsynced (service: secret_detected)', async () => {
      h.as('alice', 'a1');
      await write('ct-sec-1', 'aws key AKIAIOSFODNN7EXAMPLQ for the deploy');
      const stats = await pushToRemote();
      const [doc] = await getDocumentsByIds(COL, ['ct-sec-1']);
      if (h.name === 'service') {
        expect(stats.rejected).toBe(1);
        expect(doc.metadata).toMatchObject({ is_synced: false, sync_rejected: 'secret_detected' });
        expect(await (await backendNow()).createdAt('ct-sec-1')).toBeUndefined();
      } else {
        expect(doc.metadata.is_synced).toBe(true); // no server-side checks on a direct database
      }
    });
  });
}
