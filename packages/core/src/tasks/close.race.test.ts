import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The task write is refused after the decision was stored, as when the task changed between the check and the write.
vi.mock('./update.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./update.js')>();
  return { ...actual, updateTask: vi.fn(async () => { throw new Error('refused under the lock'); }) };
});

import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByFilter, getDocumentsByIds } from '../store/index.js';
import { metadataList } from '../metadata-adapter.js';
import { createTask } from './create.js';
import { requestDecision } from './close.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-close-race-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester' }));
  setStore(createLocalStore(dir));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('requestDecision', () => {
  it('removes the decision it stored when the task write then fails', async () => {
    const C = 'private-race';
    const id = await createTask('pick the review cadence', {}, C);
    await expect(requestDecision(id, { question: 'Monthly or quarterly?', options: ['monthly', 'quarterly'] })).rejects.toThrow(/refused under the lock/);
    expect(await getDocumentsByFilter(C, { type: 'memory' }, 100)).toHaveLength(0);
    // Nor a link to it left on the task.
    const [task] = await getDocumentsByIds(C, [id]);
    expect(metadataList(task.metadata.memory_ids)).toEqual([]);
  });
});
