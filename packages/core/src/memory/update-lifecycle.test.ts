import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig, SALIENCE_FLOOR, SALIENCE_MAX } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds, getDocumentsByFilter } from '../store/index.js';
import { updateMemory } from './update.js';
import { storeMemory } from './store.js';
import { isCuratable } from './curatable.js';

let dir: string;
const C = 'private-test';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-update-life-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester' }));
  setStore(createLocalStore(dir));
  await getStore().createCollection(C);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

const meta = async (id: string) => (await getDocumentsByIds(C, [id]))[0].metadata;

describe('updateMemory salience, pin and restore', () => {
  it('sets salience within range and restarts decay from now', async () => {
    await getStore().addDocument(C, 'm', 'a note', { type: 'memory', salience: 0.3, decayed_at: 1 });
    await updateMemory('m', { salience: 3 }, C);
    const m = await meta('m');
    expect(m.salience).toBe(3);
    expect(m.decayed_at).toBeGreaterThan(1);
    expect(m.is_synced).toBe(false);
    await updateMemory('m', { salience: 99 }, C);
    expect((await meta('m')).salience).toBe(SALIENCE_MAX);
    await updateMemory('m', { salience: 0 }, C);
    expect((await meta('m')).salience).toBe(SALIENCE_FLOOR);
    await expect(updateMemory('m', { salience: Number.NaN }, C)).rejects.toThrow(/salience/);
  });

  it('pins and unpins; time pinned never counts as decay', async () => {
    await getStore().addDocument(C, 'm', 'a note', { type: 'memory', salience: 1, decayed_at: 1 });
    await updateMemory('m', { pinned: true }, C);
    expect((await meta('m')).pinned).toBe(true);
    expect(isCuratable(await meta('m'))).toBe(false);
    expect((await meta('m')).decayed_at).toBeGreaterThan(1);
    await getStore().addDocument(C, 'm', 'a note', { ...(await meta('m')), decayed_at: 1 });
    await updateMemory('m', { pinned: false }, C);
    expect((await meta('m')).pinned).toBeUndefined();
    expect((await meta('m')).decayed_at).toBeGreaterThan(1);
    expect(isCuratable(await meta('m'))).toBe(true);
  });

  it('restores an archived memory and clears why it was archived', async () => {
    await getStore().addDocument(C, 'm', 'a note', { type: 'memory', salience: 1, archived: true, duplicate_of: 'x', expired: 'age' });
    await updateMemory('m', { restore: true }, C);
    const m = await meta('m');
    expect(m.archived).toBeUndefined();
    expect(m.duplicate_of).toBeUndefined();
    expect(m.expired).toBeUndefined();
  });

  it('refuses to restore a copy its owner deleted', async () => {
    await getStore().addDocument(C, 'm', 'a note', { type: 'memory', archived: true, deleted_upstream: true });
    await expect(updateMemory('m', { restore: true }, C)).rejects.toThrow(/deleted by its owner/);
  });

  it('applies to every chunk of a long memory', async () => {
    const r = await storeMemory('x'.repeat(5000) + ' '.repeat(1) + 'y'.repeat(5000), { collection: C, pinned: true });
    const chunks = await getDocumentsByFilter(C, { type: 'memory' }, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.metadata.pinned === true)).toBe(true);
    await updateMemory(r.ids[0].replace(/-\d+$/, ''), { pinned: false, salience: 2 }, C);
    const after = await getDocumentsByFilter(C, { type: 'memory' }, 100);
    expect(after.every(c => c.metadata.pinned === undefined && c.metadata.salience === 2)).toBe(true);
  });
});
