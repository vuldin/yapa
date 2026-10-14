import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByIds } from '../store/index.js';
import { createTask } from './create.js';
import { getTask, updateTask } from './update.js';
import { addDependency, removeDependency } from './dependencies.js';
import { deleteTask } from './delete.js';
import { searchTasks } from './search.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-tasks-test-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true' }));
  setStore(createLocalStore(dir));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('updateTask title', () => {
  it('renames the task: content, metadata title and search follow, and it is re-synced', async () => {
    const id = await createTask('draft the quarterly report', { notes: 'keep it short' }, 'project-acme');
    await updateTask(id, { is_synced: true } as any);

    await updateTask(id, { title: 'rotate the broker TLS certificates' });

    const task = await getTask(id);
    expect(task?.title).toBe('rotate the broker TLS certificates');
    expect(task?.metadata.title).toBe('rotate the broker TLS certificates');
    expect(task?.metadata.notes).toBe('keep it short');
    expect(task?.metadata.is_synced).toBe(false);
    const [doc] = await getDocumentsByIds('project-acme', [id]);
    expect(doc.content).toBe('rotate the broker TLS certificates');

    const [top] = await searchTasks('TLS certificate rotation', { collection: 'project-acme' });
    expect(top.id).toBe(id);
  });
});

describe('removeDependency', () => {
  it('removes the edge from both sides', async () => {
    const a = await createTask('task a', {}, 'project-acme');
    const b = await createTask('task b', {}, 'project-acme');
    const c = await createTask('task c', {}, 'project-acme');
    await addDependency(a, b);
    await addDependency(a, c);

    await removeDependency(a, b);

    expect((await getTask(a))?.metadata.depends_on).toEqual([c]);
    expect((await getTask(b))?.metadata.blocks ?? []).toEqual([]);
    expect((await getTask(c))?.metadata.blocks).toEqual([a]);
  });

  it('clears a dangling edge when the other task is gone', async () => {
    const a = await createTask('task d', {}, 'project-acme');
    const b = await createTask('task e', {}, 'project-acme');
    await addDependency(a, b);
    await deleteTask(b);

    await removeDependency(a, b);
    expect((await getTask(a))?.metadata.depends_on ?? []).toEqual([]);

    // And from the blocking side when the dependent task is the one deleted.
    const x = await createTask('task f', {}, 'project-acme');
    const y = await createTask('task g', {}, 'project-acme');
    await addDependency(x, y);
    await deleteTask(x);
    await removeDependency(x, y);
    expect((await getTask(y))?.metadata.blocks ?? []).toEqual([]);
  });

  it('throws when neither task exists', async () => {
    await expect(removeDependency('nope-1', 'nope-2')).rejects.toThrow(/Neither task/);
  });
});
