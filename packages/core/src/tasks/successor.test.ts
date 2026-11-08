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

import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, addDocument, getDocumentsByFilter, getDocumentsByIds } from '../store/index.js';
import { createTask, createTaskWithMetadata, TaskIdTakenError } from './create.js';
import { completeTask, getTask, updateTask } from './update.js';
import { requestDecision } from './close.js';
import { rekeyTask } from '../sync/push.js';

let dir: string;
const C = 'private-successor';
const tasks = async () => getDocumentsByFilter(C, { type: 'task' }, 1000);
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

/** A series as YAPA 1.18 left it: a completed occurrence and the open one it created, with no links. */
async function legacySeries(prefix: string, title: string, open = 1) {
  const T = 1_900_000_000;
  await addDocument(C, `${prefix}-1`, title, {
    type: 'task', id: `${prefix}-1`, status: 'complete', is_recurring: true, recurrence_pattern: 'weekly', due_date: T, completed_at: T, created_at: T - 86400, updated_at: T,
  });
  for (let i = 0; i < open; i++) {
    await addDocument(C, `${prefix}-${2 + i}`, title, {
      type: 'task', id: `${prefix}-${2 + i}`, status: 'pending', is_recurring: true, recurrence_pattern: 'weekly', due_date: T + 7 * 86400, created_at: T + 1 + i, updated_at: T + 1 + i,
    });
  }
}

describe('the next occurrence', () => {
  it('an explicit id that is taken is refused, never written over', async () => {
    const taken = await createTask('somebody else\'s task', {}, C);
    await expect(createTaskWithMetadata('mine', {}, C, { id: taken })).rejects.toBeInstanceOf(TaskIdTakenError);
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

  it('a successor made before 1.19 is found by title and linked, not duplicated', async () => {
    await legacySeries('old', 'water the ferns');
    await updateTask('old-1', { status: 'pending' });
    const r = await completeTask('old-1');
    expect(r).toMatchObject({ existingNext: 'old-2' });
    expect((await getTask('old-2'))!.metadata).toMatchObject({ previous_occurrence: 'old-1', recurrence_series: 'old-1' });
    expect((await tasks()).filter(d => d.content === 'water the ferns')).toHaveLength(2);
  });

  it('with several candidates it creates one as usual', async () => {
    await legacySeries('dup', 'dust the shelves', 2);
    await updateTask('dup-1', { status: 'pending' });
    expect((await completeTask('dup-1')).regeneratedId).toBeDefined();
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

  it('names the open occurrence of a series from before 1.19', async () => {
    await legacySeries('leg', 'sweep the yard');
    await expect(updateTask('leg-1', { lead_days: 1 })).rejects.toThrow(/leg-1 is a completed occurrence: change the series on leg-2/);
  });

  it('a refused series change through decision_needed stores no decision', async () => {
    const id = await createTask('pick the review day', { recurrence_pattern: 'weekly' }, C);
    await completeTask(id);
    await expect(requestDecision(id, { question: 'Move it to Fridays?', options: ['yes', 'no'] }, {}, { lead_days: 1 })).rejects.toThrow(/change the series on/);
    expect(await getDocumentsByFilter(C, { type: 'memory' }, 100)).toHaveLength(0);
  });

  it('keeps every id a re-keyed task had, and finds the successor by any of them', async () => {
    const id = await createTask('file the timesheet', { recurrence_pattern: 'weekly' }, C);
    const next = (await completeTask(id)).regeneratedId!;
    let [doc] = await getDocumentsByIds(C, [id]);
    const once = await rekeyTask(C, doc);
    [doc] = await getDocumentsByIds(C, [once.id]);
    const twice = await rekeyTask(C, doc);
    expect((await getTask(twice.id))!.metadata).toMatchObject({ rekeyed_from: once.id, rekeyed_from_all: [id, once.id] });
    // A successor from another machine still names the first id.
    const { patchDocument } = await import('../store/index.js');
    await patchDocument(C, next, { previous_occurrence: id });
    await updateTask(twice.id, { status: 'pending' });
    expect((await completeTask(twice.id)).existingNext).toBe(next);
  });

  it('keeps a zone this machine doesn\'t know, and counts in local time', async () => {
    const id = await createTask('call the far office', { recurrence_pattern: 'weekly', recurrence_tz: 'Mars/Olympus_Mons', due_date: 1_950_000_000 }, C);
    await updateTask(id, { recurrence_pattern: 'monthly' });
    expect((await getTask(id))!.metadata.recurrence_tz).toBe('Mars/Olympus_Mons');
    const r = await completeTask(id);
    expect((await getTask(r.regeneratedId!))!.metadata.recurrence_tz).toBe('Mars/Olympus_Mons');
  });
});
