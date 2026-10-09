/**
 * Opt-in live check of the core sync flow against the DEPLOYED sync service.
 * Skipped unless YAPA_LIVE_SERVICE_URL is set. Uses your Google ID token from
 * `gcloud auth print-identity-token` (or YAPA_SYNC_ID_TOKEN_CMD):
 *
 *   gcloud auth login
 *   YAPA_LIVE_SERVICE_URL=https://<service-url> npx vitest run src/sync/live.test.ts   (in packages/core)
 *
 * Writes only to a per-run collection project-yapa-it-<run>, only rows owned
 * by the signed-in user, and deletes every row it created afterwards (the
 * server keeps the audit/deletions entries).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setConfig, resetConfig, createConfig, getConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds, type VectorStore } from '../store/index.js';
import { HttpBackend } from './http-backend.js';
import { setSyncBackend } from './backend.js';
import { pushToRemote } from './push.js';
import { pullCollection } from './pull.js';
import { queueSyncDelete } from './deletes.js';

const URL_ = process.env.YAPA_LIVE_SERVICE_URL;
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const COL = `project-yapa-it-${RUN}`;
const NOW = Math.floor(Date.now() / 1000);

describe.skipIf(!URL_)('live sync service (opt-in)', () => {
  let dir: string;
  let backend: HttpBackend;
  const stores = new Map<string, VectorStore>();
  const created: string[] = [];

  function as(device: string) {
    setConfig({ ...createConfig({ ...process.env, YAPA_DEVICE_ID: `it-${device}-${RUN}`, YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: URL_, YAPA_SYNC_PUSH_DEBOUNCE_MS: '0' }), USERNAME: getConfig().USERNAME });
    if (!stores.has(device)) stores.set(device, createLocalStore(join(dir, device)));
    setStore(stores.get(device)!);
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yapa-live-'));
    setConfig(createConfig({ ...process.env, YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: URL_ }));
    backend = new HttpBackend();
    setSyncBackend(backend);
    await backend.prepare(); // signs in; the service's username becomes USERNAME
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

  it('push, pull from a second device, delete, deletion applied', async () => {
    const id = `it-mem-${RUN}`;
    created.push(id);

    as('a');
    await getStore().getOrCreateCollection(COL);
    await getStore().addDocument(COL, id, `yapa live integration check ${RUN}`, { type: 'memory', created_at: NOW, updated_at: NOW, is_synced: false });
    const pushed = await pushToRemote();
    expect(pushed.errors).toBe(0);
    expect(await backend.createdAt(id)).toBe(NOW);

    as('b');
    const pulled = await pullCollection(COL, 0);
    expect(pulled.errors).toBe(0);
    const [copy] = await getDocumentsByIds(COL, [id]);
    expect(copy?.metadata.origin_user).toBe(getConfig().USERNAME);

    as('a');
    await getStore().deleteDocument(COL, id);
    await queueSyncDelete(id, COL);
    expect((await pushToRemote()).deleted).toBe(1);
    expect(await backend.createdAt(id)).toBeUndefined();

    as('b');
    const after = await pullCollection(COL, 0);
    expect(after.deleted).toBe(1);
    expect(await getDocumentsByIds(COL, [id])).toEqual([]);
  }, 120_000);
});
