import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The id allocated before the lock, on demand: as when a concurrent create takes it meanwhile.
const preset = vi.hoisted(() => ({ id: undefined as string | undefined }));
vi.mock('./create.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./create.js')>();
  return {
    ...actual,
    freshTaskId: vi.fn(async () => {
      if (preset.id) { const id = preset.id; preset.id = undefined; return id; }
      return actual.freshTaskId();
    }),
  };
});
// One read of a task returns it as complete: the read before the lock, when another session reopens it meanwhile.
const stale = vi.hoisted(() => ({ id: undefined as string | undefined }));
vi.mock('../store/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../store/index.js')>();
  return {
    ...actual,
    getDocumentsByIds: vi.fn(async (...args: Parameters<typeof actual.getDocumentsByIds>) => {
      const r = await actual.getDocumentsByIds(...args);
      if (stale.id && args[1].includes(stale.id) && r.length) {
        stale.id = undefined;
        return r.map(d => ({ ...d, metadata: { ...d.metadata, status: 'complete' } }));
      }
      return r;
    }),
  };
});

import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, addDocument, getDocumentsByFilter, getDocumentsByIds } from '../store/index.js';
import { addLeftCollection, clearLeftCollection, CollectionLeftError } from '../sync/sentinel.js';
import { createTask, createTaskWithMetadata } from './create.js';
import { completeTask, getTask, updateTask } from './update.js';
import { requestDecision } from './close.js';

let dir: string;
const C = 'private-successor';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-successor-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester' }));
  setStore(createLocalStore(dir));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('the next occurrence', () => {
  it('an id that is taken is skipped, never written over', async () => {
    const taken = await createTask('somebody else\'s task', {}, C);
    const made = await createTaskWithMetadata('mine', {}, C, { id: taken });
    expect(made.id).not.toBe(taken);
    expect((await getTask(taken))!.title).toBe('somebody else\'s task');
  });

  it('a pre-allocated id taken by a concurrent create is skipped', async () => {
    const id = await createTask('order the printer paper', { recurrence_pattern: 'monthly' }, C);
    preset.id = 'tester-7777';
    await addDocument(C, 'tester-7777', 'created meanwhile', { type: 'task', id: 'tester-7777', status: 'pending', created_at: 1, updated_at: 1 });
    const r = await completeTask(id);
    expect(r.regeneratedId).toBeDefined();
    expect(r.regeneratedId).not.toBe('tester-7777');
    const [kept] = await getDocumentsByIds(C, ['tester-7777']);
    expect(kept.content).toBe('created meanwhile');
    expect((await getTask(r.regeneratedId!))!.metadata.previous_occurrence).toBe(id);
  });

  it('decides under the lock: a task read as complete but reopened meanwhile is completed, with a next occurrence', async () => {
    const id = await createTask('wipe the whiteboard', { recurrence_pattern: 'daily' }, C);
    stale.id = id;
    const r = await completeTask(id);
    expect(r.regeneratedId).toBeDefined();
    expect((await getTask(id))!.metadata).toMatchObject({ status: 'complete', next_occurrence: r.regeneratedId });
    expect(r.nudge).toBeDefined();
  });

  it('a series change is refused on a completed occurrence even when the same call reopens it', async () => {
    const id = await createTask('reconcile the bank feed', { recurrence_pattern: 'weekly' }, C);
    const next = (await completeTask(id)).regeneratedId!;
    await expect(updateTask(id, { status: 'pending', lead_days: 1 })).rejects.toThrow(new RegExp(`change the series on ${next}`));
    expect((await getTask(id))!.metadata.status).toBe('complete');
    // With nothing open after it, reopening makes it the open one.
    await updateTask(next, { recurrence_pattern: 'none' });
    await completeTask(next);
    await expect(updateTask(next, { status: 'pending', recurrence_pattern: 'weekly' })).resolves.toBeDefined();
  });

  it('a reopened occurrence with an open successor refuses series changes, naming it', async () => {
    const id = await createTask('rotate the passwords', { recurrence_pattern: 'monthly' }, C);
    const next = (await completeTask(id)).regeneratedId!;
    await updateTask(id, { status: 'pending' });
    await expect(updateTask(id, { recurrence_interval: 2 })).rejects.toThrow(new RegExp(`${id} isn't the open occurrence of its series: change the series on ${next}`));
    expect((await getTask(id))!.metadata.recurrence_interval).toBe(1);
  });

  it('a recurring task created without a due date is due at the end of today in its zone', async () => {
    const id = await createTask('call the Tokyo office', { recurrence_pattern: 'daily', recurrence_tz: 'Asia/Tokyo' }, C);
    const due = (await getTask(id))!.metadata.due_date;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(due * 1000));
    const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
    expect([get('hour'), get('minute'), get('second')]).toEqual([23, 59, 59]);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    expect(`${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`).toBe(today);
  });

  it('a refused series change through decision_needed stores no decision', async () => {
    const id = await createTask('pick the review day', { recurrence_pattern: 'weekly' }, C);
    await completeTask(id);
    await expect(requestDecision(id, { question: 'Move it to Fridays?', options: ['yes', 'no'] }, {}, { lead_days: 1 })).rejects.toThrow(/change the series on/);
    expect(await getDocumentsByFilter(C, { type: 'memory' }, 100)).toHaveLength(0);
  });

  it('a collection removed from this machine refuses the completion before anything is written', async () => {
    const L = 'project-left-behind';
    const id = await createTask('archive the old project', { recurrence_pattern: 'monthly' }, L);
    await addLeftCollection(L);
    try {
      await expect(completeTask(id)).rejects.toBeInstanceOf(CollectionLeftError);
      expect((await getTask(id))!.metadata.status).toBe('pending');
      expect((await getDocumentsByFilter(L, { type: 'task' }, 100))).toHaveLength(1);
    } finally {
      await clearLeftCollection(L);
    }
  });

  it('keeps a zone this machine doesn\'t know, and counts in local time', async () => {
    const id = await createTask('call the far office', { recurrence_pattern: 'weekly', recurrence_tz: 'Mars/Olympus_Mons', due_date: 1_950_000_000 }, C);
    await updateTask(id, { recurrence_pattern: 'monthly' });
    expect((await getTask(id))!.metadata.recurrence_tz).toBe('Mars/Olympus_Mons');
    const r = await completeTask(id);
    expect((await getTask(r.regeneratedId!))!.metadata.recurrence_tz).toBe('Mars/Olympus_Mons');
  });
});
