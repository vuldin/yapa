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
    createTask: vi.fn(async (...args: Parameters<typeof actual.createTask>) => {
      if (failNext.on) {
        failNext.on = false;
        throw new Error('store unavailable');
      }
      return actual.createTask(...args);
    }),
  };
});

import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore } from '../store/index.js';
import { createTask } from './create.js';
import { completeTask, getTask } from './update.js';

let dir: string;
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

describe('completeTask when the next occurrence cannot be created', () => {
  it('says so, and completing the task again creates it', async () => {
    const id = await createTask('water the garden', { recurrence_pattern: 'daily' }, 'private-retry');
    failNext.on = true;
    await expect(completeTask(id)).rejects.toThrow(/is complete, but its next occurrence could not be created \(store unavailable\): complete it again to retry/);
    expect((await getTask(id))!.metadata).toMatchObject({ status: 'complete' });
    expect((await getTask(id))!.metadata.next_occurrence).toBeUndefined();

    const retry = await completeTask(id);
    expect(retry.regeneratedId).toBeDefined();
    expect((await getTask(id))!.metadata.next_occurrence).toBe(retry.regeneratedId);
    expect((await completeTask(id)).regeneratedId).toBeUndefined();
  });
});
