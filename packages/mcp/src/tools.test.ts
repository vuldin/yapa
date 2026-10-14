import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const { scheduleSyncSoon } = vi.hoisted(() => ({ scheduleSyncSoon: vi.fn() }));
vi.mock('@yapa/core', async importOriginal => ({ ...(await importOriginal<any>()), scheduleSyncSoon }));

import {
  createConfig, createLocalStore, createNewCollection, createTask, getTask, listCollections,
  resetConfig, resetStore, setConfig, setStore,
} from '@yapa/core';
import { withSyncOnWrite, SYNC_ON_WRITE_TOOLS, registerTools } from './tools.js';

function fakeServer() {
  const handlers = new Map<string, (...a: any[]) => any>();
  const server: any = { tool: (name: string, ...rest: any[]) => { handlers.set(name, rest[rest.length - 1]); } };
  return { server, handlers };
}

describe('withSyncOnWrite', () => {
  it('schedules a sync after write tools resolve, not for reads', async () => {
    const { server, handlers } = fakeServer();
    withSyncOnWrite(server);
    server.tool('memory_store', 'desc', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    server.tool('memory_recall', 'desc', {}, async () => ({ content: [] }));

    const result = await handlers.get('memory_store')!({});
    expect(result.content[0].text).toBe('ok');
    expect(scheduleSyncSoon).toHaveBeenCalledTimes(1);

    await handlers.get('memory_recall')!({});
    expect(scheduleSyncSoon).toHaveBeenCalledTimes(1);
  });

  it('covers every tool that mutates syncable state', () => {
    for (const name of ['memory_store', 'memory_forget', 'task_create', 'task_update', 'task_complete', 'task_delete', 'task_remove_dependency', 'collection_merge', 'journal_consolidate', 'compaction_apply']) {
      expect(SYNC_ON_WRITE_TOOLS.has(name)).toBe(true);
    }
  });
});

describe('registered tools over the local store', () => {
  let dir: string;
  const tools = new Map<string, { schema: Record<string, any>; handler: (...a: any[]) => any }>();
  /** Validate args with the tool's own schema, as the MCP SDK does, then run it. */
  const call = async (name: string, args: Record<string, any>) => {
    const t = tools.get(name)!;
    return t.handler(z.object(t.schema).parse(args));
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yapa-mcp-tools-test-'));
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true' }));
    setStore(createLocalStore(dir));
    const server: any = {
      tool: (name: string, ...rest: any[]) => {
        tools.set(name, { schema: rest.length === 3 ? rest[1] : {}, handler: rest[rest.length - 1] });
      },
    };
    registerTools(server);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    resetStore();
    resetConfig();
  });

  it('task_update renames a task via title, and rejects an empty title', async () => {
    const id = await createTask('old title', {}, 'project-acme');
    await call('task_update', { id, title: 'new title' });
    expect((await getTask(id))?.title).toBe('new title');
    await expect(call('task_update', { id, title: '  ' })).rejects.toThrow();
  });

  it('task_remove_dependency removes an edge added by task_add_dependency', async () => {
    const a = await createTask('a', {}, 'project-acme');
    const b = await createTask('b', {}, 'project-acme');
    await call('task_add_dependency', { task_id: a, depends_on_id: b });
    const res = await call('task_remove_dependency', { task_id: a, depends_on_id: b });
    expect(res.content[0].text).toBe(`${a} no longer depends on ${b}`);
    expect((await getTask(a))?.metadata.depends_on ?? []).toEqual([]);
  });

  it('collection_delete refuses a non-empty shared collection until confirmed', async () => {
    await expect(call('collection_delete', { name: 'project-acme' })).rejects.toThrow(/EVERY teammate.*collection_merge/s);
    await createNewCollection('customer-into');
    const merged = await call('collection_merge', { from: 'project-acme', into: 'customer-into', dry_run: true });
    expect(merged.content[0].text).toMatch(/^Dry run: would move 3 document/);
    await call('collection_delete', { name: 'project-acme', confirm: 'project-acme' });
    expect((await listCollections()).map(c => c.name)).not.toContain('project-acme');
  });
});
