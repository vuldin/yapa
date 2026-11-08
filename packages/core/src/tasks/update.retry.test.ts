import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The next occurrence's write fails once, as when the store is unavailable for a moment.
const failNext = vi.hoisted(() => ({ on: false }));
vi.mock('./create.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./create.js')>();
  return {
    ...actual,
    createTaskWithMetadata: vi.fn(async (...args: Parameters<typeof actual.createTaskWithMetadata>) => {
      if (failNext.on && args[3]?.id) {
        failNext.on = false;
        throw new Error('store unavailable');
      }
      return actual.createTaskWithMetadata(...args);
    }),
  };
});

import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, addDocument, patchDocument } from '../store/index.js';
import { createTask } from './create.js';
import { completeTask, getTask } from './update.js';
import { RegenerationError } from './recurrence.js';

let dir: string;
const C = 'private-retry';
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
  it('a failed create says so; completing again creates it with the reserved id, without closing the task again', async () => {
    const id = await createTask('water the garden', { recurrence_pattern: 'daily' }, C);
    failNext.on = true;
    const err = await completeTask(id).catch(e => e);
    expect(err).toBeInstanceOf(RegenerationError);
    expect(err.message).toMatch(/is complete, but its next occurrence could not be created \(store unavailable\): complete it again to retry/);
    const done = (await getTask(id))!.metadata;
    expect(done.status).toBe('complete');
    const reserved = done.next_occurrence;
    expect(reserved).toMatch(/^tester-\d+$/);
    expect(await getTask(reserved)).toBeNull();

    const retry = await completeTask(id);
    expect(retry.regeneratedId).toBe(reserved);
    expect(retry.nudge).toBeUndefined();
    expect((await getTask(reserved))!.metadata).toMatchObject({ previous_occurrence: id, status: 'pending' });
    expect((await getTask(id))!.metadata.salience).toBe(done.salience);
    expect((await completeTask(id)).regeneratedId).toBeUndefined();
  });

  it('a task completed before 1.19 (no next_occurrence) and completed again creates nothing', async () => {
    await addDocument(C, 'tester-970', 'clean the gutters', {
      type: 'task', id: 'tester-970', status: 'complete', is_recurring: true, recurrence_pattern: 'monthly',
      due_date: 1_900_000_000, completed_at: 1_899_000_000, salience: 1, created_at: 1, updated_at: 1,
    });
    expect((await completeTask('tester-970')).regeneratedId).toBeUndefined();
    expect((await getTask('tester-970'))!.metadata).toMatchObject({ salience: 1 });
  });

  it('a reservation left by a crash is completed with the same id', async () => {
    const id = await createTask('check the smoke alarm', { recurrence_pattern: 'monthly' }, C);
    await completeTask(id);
    const next = (await getTask(id))!.metadata.next_occurrence as string;
    const later = await completeTask(next);
    const reservedId = 'tester-5000';
    await patchDocument(C, next, { next_occurrence: reservedId });
    await expect(getTask(reservedId)).resolves.toBeNull();
    expect((await completeTask(next)).regeneratedId).toBe(reservedId);
    expect((await getTask(reservedId))!.metadata.previous_occurrence).toBe(next);
    expect(later.regeneratedId).not.toBe(reservedId);
  });
});
