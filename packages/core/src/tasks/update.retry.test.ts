import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One write fails on demand: the next occurrence's create, or the completion itself.
const fail = vi.hoisted(() => ({ create: false, patch: false, filter: false }));
vi.mock('./create.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./create.js')>();
  return {
    ...actual,
    createTaskWithMetadata: vi.fn(async (...args: Parameters<typeof actual.createTaskWithMetadata>) => {
      if (fail.create) { fail.create = false; throw new Error('store unavailable'); }
      return actual.createTaskWithMetadata(...args);
    }),
  };
});
vi.mock('../store/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../store/index.js')>();
  return {
    ...actual,
    patchDocument: vi.fn(async (...args: Parameters<typeof actual.patchDocument>) => {
      if (fail.patch) { fail.patch = false; throw new Error('disk full'); }
      return actual.patchDocument(...args);
    }),
    getDocumentsByFilter: vi.fn(async (...args: Parameters<typeof actual.getDocumentsByFilter>) => {
      if (fail.filter && (args[1] as any)?.previous_occurrence) { fail.filter = false; throw new Error('index unavailable'); }
      return actual.getDocumentsByFilter(...args);
    }),
  };
});

import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, addDocument, deleteDocument, getDocumentsByFilter, getDocumentsByIds } from '../store/index.js';
import { createTask } from './create.js';
import { completeTask, getTask, updateTask } from './update.js';

let dir: string;
const C = 'private-retry';
const successorsOf = async (id: string) => (await getDocumentsByFilter(C, { type: 'task' }, 1000)).filter(d => d.metadata.previous_occurrence === id);
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-regen-retry-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester' }));
  setStore(createLocalStore(dir));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('completeTask and the next occurrence', () => {
  it('a failed create leaves the task open with nothing recorded; a plain retry completes it', async () => {
    const id = await createTask('water the garden', { recurrence_pattern: 'daily' }, C);
    fail.create = true;
    await expect(completeTask(id, undefined, {}, { learned: [{ content: 'the hose leaks at the tap', kind: 'finding' }] })).rejects.toThrow(/store unavailable/);
    expect((await getTask(id))!.metadata).toMatchObject({ status: 'pending' });
    expect((await getTask(id))!.metadata.next_occurrence).toBeUndefined();
    expect(await getDocumentsByFilter(C, { type: 'memory' }, 100)).toHaveLength(0);

    const r = await completeTask(id);
    expect((await getTask(id))!.metadata).toMatchObject({ status: 'complete', next_occurrence: r.regeneratedId });
    expect(await successorsOf(id)).toHaveLength(1);
  });

  it('a failed completion write after the create leaves one successor once retried', async () => {
    const id = await createTask('sweep the porch', { recurrence_pattern: 'weekly' }, C);
    fail.patch = true;
    await expect(completeTask(id)).rejects.toThrow(/disk full/);
    expect((await getTask(id))!.metadata.status).toBe('pending');
    const [made] = await successorsOf(id);
    expect(made).toBeDefined();

    const r = await completeTask(id);
    expect(r).toMatchObject({ existingNext: made.id });
    expect(await successorsOf(id)).toHaveLength(1);
    expect((await getTask(id))!.metadata).toMatchObject({ status: 'complete', next_occurrence: made.id });
  });

  it('a failed successor lookup is an error, not "no successor": nothing is written', async () => {
    const id = await createTask('descale the kettle', { recurrence_pattern: 'monthly' }, C);
    fail.filter = true;
    await expect(completeTask(id)).rejects.toThrow(/index unavailable/);
    expect((await getTask(id))!.metadata.status).toBe('pending');
    expect(await successorsOf(id)).toHaveLength(0);
  });

  it('records learned items and follow-ups on an already-complete task with no other fields', async () => {
    const id = await createTask('sort the receipts', {}, C);
    await completeTask(id);
    const r = await completeTask(id, undefined, {}, { learned: [{ content: 'receipts older than a year can go', kind: 'finding' }], follow_ups: [{ title: 'shred the old receipts' }] });
    expect(r.recorded?.memories).toHaveLength(1);
    expect(r.recorded?.follow_ups).toHaveLength(1);
    expect((await getTask(id))!.metadata.memory_ids).toEqual(r.recorded!.memories);
  });

  it('two completions at once create one successor', async () => {
    const id = await createTask('feed the fish', { recurrence_pattern: 'daily' }, C);
    await Promise.all([completeTask(id), completeTask(id)]);
    expect(await successorsOf(id)).toHaveLength(1);
  });

  it('a deleted successor stays deleted when the completed task is updated again', async () => {
    const id = await createTask('check the tyre pressure', { recurrence_pattern: 'monthly' }, C);
    const r = await completeTask(id);
    await deleteDocument(C, r.regeneratedId!);
    expect((await completeTask(id, 20)).regeneratedId).toBeUndefined();
    await updateTask(id, { duration_minutes: 25 });
    expect(await successorsOf(id)).toHaveLength(0);
    expect((await getTask(id))!.metadata.duration_minutes).toBe(25);
  });

  it('a task completed before 1.19 and completed again creates nothing', async () => {
    await addDocument(C, 'tester-970', 'clean the gutters', {
      type: 'task', id: 'tester-970', status: 'complete', is_recurring: true, recurrence_pattern: 'monthly',
      due_date: 1_900_000_000, completed_at: 1_899_000_000, salience: 1, created_at: 1, updated_at: 1,
    });
    expect((await completeTask('tester-970')).regeneratedId).toBeUndefined();
    expect(await successorsOf('tester-970')).toHaveLength(0);
    expect((await getTask('tester-970'))!.metadata.salience).toBe(1);
  });

  it('the series-change check finds the open occurrence after a re-key', async () => {
    const id = await createTask('back up the photos', { recurrence_pattern: 'weekly' }, C);
    const next = (await completeTask(id)).regeneratedId!;
    // Re-keyed by sync: the same task under a new id, still pointing back at its predecessor.
    const [doc] = await getDocumentsByIds(C, [next]);
    await deleteDocument(C, next);
    await addDocument(C, 'tester-6000', doc.content, { ...doc.metadata, id: 'tester-6000', rekeyed_from: next });
    await expect(updateTask(id, { lead_days: 1 })).rejects.toThrow(new RegExp(`${id} isn't the open occurrence of its series: change the series on tester-6000`));
  });
});
