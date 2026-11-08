import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByFilter, getDocumentsByIds, patchDocument } from '../store/index.js';
import { rekeyTask } from '../sync/push.js';
import { createTask } from './create.js';
import { completeTask, getTask, updateTask } from './update.js';

let dir: string;
const C = 'private-rekey';
const successorsOf = async (id: string) => (await getDocumentsByFilter(C, { type: 'task' }, 1000)).filter(d => d.metadata.previous_occurrence === id);
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-rekey-recurrence-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester' }));
  setStore(createLocalStore(dir));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('a re-keyed occurrence keeps its successor', () => {
  it('rekeyTask points the successor at the new id, and completing again finds it either way', async () => {
    const id = await createTask('file the expense report', { recurrence_pattern: 'monthly' }, C);
    const next = (await completeTask(id)).regeneratedId!;
    const [doc] = await getDocumentsByIds(C, [id]);
    const moved = await rekeyTask(C, doc);
    expect(moved.id).not.toBe(id);
    expect((await getTask(next))!.metadata.previous_occurrence).toBe(moved.id);

    // A successor from another machine still names the old id: found through rekeyed_from.
    await patchDocument(C, next, { previous_occurrence: id });
    await updateTask(moved.id, { status: 'pending' });
    expect((await completeTask(moved.id)).existingNext).toBe(next);
    expect(await successorsOf(moved.id)).toHaveLength(0);
    expect(await successorsOf(id)).toHaveLength(1);
  });
});
