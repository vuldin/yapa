/**
 * Opt-in integration suite against a REAL PostgreSQL+pgvector database.
 * Skipped unless YAPA_IT_DATABASE_URL is set:
 *
 *   YAPA_IT_DATABASE_URL=postgres://... npm run test:integration -w packages/core
 *
 * Set YAPA_SYNC_CA_CERT too to run over verified TLS.
 *
 * Every run uses unique throwaway usernames and collections (suffix below),
 * each user/device gets its own local store, and all rows written by the run
 * are deleted afterwards, even when a test fails. Rows of other users are
 * never touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds, type VectorStore } from '../store/index.js';
import { storeMemory } from '../memory/store.js';
import { forgetMemory } from '../memory/forget.js';
import { createTask, getNextTaskId } from '../tasks/create.js';
import { updateTask, completeTask } from '../tasks/update.js';
import { pushToRemote } from './push.js';
import { pullFromRemote, pullCollection } from './pull.js';
import { updateSyncSubscriptions } from './sentinel.js';
import { getLocalTombstones } from './deletes.js';
import { getPool, closePool } from './postgres.js';
import { migrateSchema } from './schema.js';

const URL = process.env.YAPA_IT_DATABASE_URL;
const RUN = `it${Date.now().toString(36)}`;
const user = (name: string) => `${name}-${RUN}`;
const COL = `project-yapa-it-${RUN}`;
const MOVE_A = `project-yapa-it-a-${RUN}`;
const MOVE_B = `project-yapa-it-b-${RUN}`;

let dir: string;
const stores = new Map<string, VectorStore>();

/** Switch the process to `name` on `device` (own config + own local store). */
function as(name: string, device: string, env: Record<string, string> = {}): void {
  setConfig(createConfig({
    YAPA_USERNAME: user(name),
    YAPA_DEVICE_ID: `${device}-${RUN}`,
    YAPA_SYNC_ENABLED: 'true',
    YAPA_SYNC_DATABASE_URL: URL,
    YAPA_SYNC_PUSH_DEBOUNCE_MS: '0',
    YAPA_SYNC_CA_CERT: process.env.YAPA_SYNC_CA_CERT ?? '',
    ...env,
  }));
  if (!stores.has(device)) stores.set(device, createLocalStore(join(dir, device)));
  setStore(stores.get(device)!);
}

async function freshDevice(name: string, device: string, subscriptions: string[]): Promise<void> {
  as(name, device);
  await getStore().createCollection('global');
  await updateSyncSubscriptions(subscriptions);
  await pullFromRemote();
}

const has = async (col: string, id: string) => (await getDocumentsByIds(col, [id]).catch(() => [])).length === 1;
const remoteRow = async (id: string) =>
  (await getPool().query('SELECT collection, content, origin_user FROM documents WHERE id = $1', [id])).rows[0];

describe.skipIf(!URL)('sync against a real database', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yapa-it-'));
    as('setup', 'setup');
    await migrateSchema();
  });

  afterAll(async () => {
    try {
      await getPool().query(
        "DELETE FROM documents WHERE origin_user LIKE $1 OR collection = ANY($2::text[])",
        [`%-${RUN}`, [COL, MOVE_A, MOVE_B]],
      );
    } finally {
      await closePool();
      rmSync(dir, { recursive: true, force: true });
      resetStore();
      resetConfig();
    }
  });

  describe('multi-user model', () => {
    let mem: string;
    let task: string;
    let personal: string;

    it('alice pushes a memory, a task, and a personal note', async () => {
      as('alice', 'alice-A');
      mem = (await storeMemory('IT: orchid cluster rotates SASL creds every 14 days', { collection: COL, salience: 3 })).ids[0];
      task = await createTask('IT: rotate orchid creds', { priority: 'high' }, COL);
      personal = (await storeMemory('IT: alice prefers short status updates', { collection: 'global' })).ids[0];
      const stats = await pushToRemote();
      expect(stats.errors).toBe(0);
      expect((await remoteRow(mem))?.collection).toBe(COL);
      expect((await remoteRow(task))?.collection).toBe(COL);
      expect(await remoteRow(personal)).toBeUndefined(); // global never leaves the machine
    });

    it('a teammate subscribing later backfills history but never gets personal global', async () => {
      await freshDevice('bob', 'bob-B', [COL]);
      expect(await has(COL, mem)).toBe(true);
      expect(await has(COL, task)).toBe(true);
      expect((await getDocumentsByIds(COL, [mem]))[0].metadata.origin_user).toBe(user('alice'));
      expect(await has('global', personal)).toBe(false);
    });

    it('a teammate completing the task reaches the owner', async () => {
      await new Promise(r => setTimeout(r, 1100)); // updated_at has 1s resolution
      await completeTask(task, 45);
      await pushToRemote();
      as('alice', 'alice-A');
      const stats = await pullCollection(COL, 0);
      expect(stats.updated).toBe(1);
      const [t] = await getDocumentsByIds(COL, [task]);
      expect(t.metadata).toMatchObject({ status: 'complete', duration_minutes: 45 });
    });

    it('forgetting a teammate\'s memory only removes it locally', async () => {
      as('bob', 'bob-B');
      await forgetMemory(mem);
      await pushToRemote();
      expect(await remoteRow(mem)).toBeDefined();
      expect((await getLocalTombstones()).has(mem)).toBe(true);
      await pullCollection(COL, 0);
      expect(await has(COL, mem)).toBe(false);
    });

    it('global is never shared, even with a leftover YAPA_SYNC_SHARE_GLOBAL', async () => {
      as('bob', 'bob-B', { YAPA_SYNC_SHARE_GLOBAL: 'true' });
      await pullCollection('global', 0);
      expect(await has('global', personal)).toBe(false);
    });

    it('the same user\'s second device receives their shared rows, but not global (local-only)', async () => {
      await freshDevice('alice', 'alice-A2', [COL]);
      expect(await has(COL, mem)).toBe(true);
      expect(await has('global', personal)).toBe(false);
    });

    it('an older client\'s shared copy of a global doc is removed by the next push', async () => {
      as('alice', 'alice-A');
      const [doc] = await getDocumentsByIds('global', [personal]);
      await getPool().query(
        `INSERT INTO documents (id, collection, content, embedding, metadata, origin_user, created_at, updated_at)
         VALUES ($1, 'global', $2, '[1,0,0]', $3, $4, to_timestamp($5), to_timestamp($5))`,
        [personal, doc.content, doc.metadata, user('alice'), doc.metadata.created_at],
      );
      await getStore().addDocument('global', personal, doc.content, { ...doc.metadata, updated_at: Number(doc.metadata.created_at) + 1 });
      const stats = await pushToRemote();
      expect(stats.retracted).toBe(1);
      expect(await remoteRow(personal)).toBeUndefined();
    });

    it('a device does not re-pull its own writes', async () => {
      as('alice', 'alice-A');
      expect((await pullCollection(COL, 0)).pulled).toBe(0);
    });

    it('the owner forgetting their memory deletes the shared row', async () => {
      await forgetMemory(mem);
      await pushToRemote();
      expect(await remoteRow(mem)).toBeUndefined();
    });
  });

  describe('private collections', () => {
    it('an owner moving a doc into private- removes its shared row; a teammate\'s row survives a private copy', async () => {
      const PRIV = `private-yapa-it-${RUN}`;
      as('alice', 'pv-alice');
      const own = (await storeMemory('IT: will move private', { collection: COL })).ids[0];
      await pushToRemote();
      expect(await remoteRow(own)).toBeDefined();
      as('bob', 'pv-bob');
      const theirs = (await storeMemory('IT: bob shared note', { collection: COL })).ids[0];
      await pushToRemote();

      as('alice', 'pv-alice');
      const [doc] = await getDocumentsByIds(COL, [own]);
      await getStore().createCollection(PRIV);
      await getStore().addDocument(PRIV, own, doc.content, doc.metadata);
      await getStore().deleteDocument(COL, own);
      await getStore().addDocument(PRIV, theirs, 'IT: bob shared note', { type: 'memory', origin_user: user('bob'), created_at: 1 });
      const stats = await pushToRemote();

      expect(stats.retracted).toBe(1);
      expect(await remoteRow(own)).toBeUndefined();
      expect((await remoteRow(theirs))?.origin_user).toBe(user('bob'));
    });
  });

  describe('collection moves and task-id collisions', () => {
    let id: string;
    let original: { content: string; metadata: Record<string, any> };

    it('setup: alice\'s task is visible to bob (A+B), carol (A) and dave (A+B)', async () => {
      as('alice', 'mv-alice');
      id = await createTask('IT: move test task', { priority: 'high' }, MOVE_A);
      await pushToRemote();
      await freshDevice('bob', 'mv-bob', [MOVE_A, MOVE_B]);
      expect(await has(MOVE_A, id)).toBe(true);
      await freshDevice('carol', 'mv-carol', [MOVE_A]);
      expect(await has(MOVE_A, id)).toBe(true);
      await freshDevice('dave', 'mv-dave', [MOVE_A, MOVE_B]);
      await updateTask(id, { notes: 'dave local edit, not pushed' });
    });

    it('the owner\'s move propagates to the shared row', async () => {
      as('alice', 'mv-alice');
      const [doc] = await getDocumentsByIds(MOVE_A, [id]);
      original = { content: doc.content, metadata: doc.metadata };
      await getStore().deleteDocument(MOVE_A, id);
      await getStore().createCollection(MOVE_B);
      await getStore().addDocument(MOVE_B, id, doc.content, {
        ...doc.metadata, updated_at: Math.floor(Date.now() / 1000) + 5, is_synced: false,
      });
      await pushToRemote();
      expect((await remoteRow(id))?.collection).toBe(MOVE_B);
      expect((await remoteRow(id))?.origin_user).toBe(user('alice'));
    });

    it('a device following both collections relocates its copy', async () => {
      as('bob', 'mv-bob');
      await pullFromRemote();
      expect(await has(MOVE_B, id)).toBe(true);
      expect(await has(MOVE_A, id)).toBe(false);
    });

    it('a device following only the old collection drops its stale copy', async () => {
      as('carol', 'mv-carol');
      await pullFromRemote();
      expect(await has(MOVE_A, id)).toBe(false);
      expect(await has(MOVE_B, id)).toBe(false);
    });

    it('a copy with unpushed edits is kept', async () => {
      as('dave', 'mv-dave');
      await pullFromRemote();
      expect(await has(MOVE_A, id)).toBe(true);
    });

    it('a different task reusing an id is renamed instead of overwriting', async () => {
      as('erin', 'mv-erin-fresh');
      await getStore().createCollection(MOVE_A);
      await getStore().addDocument(MOVE_A, id, 'IT: a DIFFERENT task with a reused id', {
        type: 'task', id, created_at: 1_700_000_000, updated_at: 1_700_000_000, is_synced: false,
      });
      await pushToRemote();
      const row = await remoteRow(id);
      expect(row?.content).toBe(original.content);
      expect(row?.collection).toBe(MOVE_B);
      const renamed = (await getPool().query("SELECT id FROM documents WHERE metadata->>'rekeyed_from' = $1", [id])).rows;
      expect(renamed).toHaveLength(1);
      expect(renamed[0].id).not.toBe(id);
    });

    it('a brand-new device mints task ids past those already used remotely', async () => {
      as('alice', 'mv-alice-new');
      const next = await getNextTaskId();
      expect(Number(next.split('-').pop())).toBeGreaterThan(Number(id.split('-').pop()));
    });
  });
});
