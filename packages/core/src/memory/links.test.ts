import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, addDocument, getDocumentsByIds } from '../store/index.js';
import { metadataList } from '../metadata-adapter.js';
import { linkMemoryToTasks } from './links.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-links-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester' }));
  setStore(createLocalStore(dir));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('linkMemoryToTasks', () => {
  it('reads memory_ids written as "a, b" without appending a second b', async () => {
    await addDocument('private-links', 'tester-1', 'a task', { type: 'task', id: 'tester-1', status: 'pending', memory_ids: 'mem-a, mem-b', created_at: 1, updated_at: 1 });
    expect(await linkMemoryToTasks('mem-b', ['tester-1'])).toEqual({ linked: ['tester-1'], missing: [] });
    const [t] = await getDocumentsByIds('private-links', ['tester-1']);
    expect(metadataList(t.metadata.memory_ids)).toEqual(['mem-a', 'mem-b']);
  });
});
