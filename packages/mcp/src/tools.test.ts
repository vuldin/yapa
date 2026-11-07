import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const { scheduleSyncSoon } = vi.hoisted(() => ({ scheduleSyncSoon: vi.fn() }));
vi.mock('@yapa/core', async importOriginal => ({ ...(await importOriginal<any>()), scheduleSyncSoon }));

import {
  createConfig, createLocalStore, createNewCollection, createTask, getTask, listCollections,
  readLastWrite, resetConfig, resetStore, setConfig, setStore,
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
    for (const name of ['memory_store', 'memory_update', 'memory_forget', 'task_create', 'task_update', 'task_complete', 'task_delete', 'task_remove_dependency', 'collection_merge', 'journal_consolidate', 'compaction_apply']) {
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
    // This session works in a project folder: it may create shared collections.
    await writeFile(join(dir, 'scope.json'), JSON.stringify({ project_roots: [join(dir, 'projects')] }));
    process.env.CLAUDE_PROJECT_DIR = join(dir, 'projects', 'acme');
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true', YAPA_SCOPE_FILE: join(dir, 'scope.json') }));
    setStore(createLocalStore(dir));
    const server: any = {
      tool: (name: string, ...rest: any[]) => {
        tools.set(name, { schema: rest.length === 3 ? rest[1] : {}, handler: rest[rest.length - 1] });
      },
    };
    registerTools(server);
  });

  afterAll(async () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    await rm(dir, { recursive: true, force: true });
    resetStore();
    resetConfig();
  });

  describe('a session outside every project root', () => {
    const outside = () => { process.env.CLAUDE_PROJECT_DIR = join(dir, 'home'); };
    const back = () => { process.env.CLAUDE_PROJECT_DIR = join(dir, 'projects', 'acme'); };

    it('cannot create a new shared collection by writing to it, or by collection_create', async () => {
      outside();
      try {
        for (const [tool, args] of [
          ['memory_store', { content: 'x', collection: 'customer-newco' }],
          ['task_create', { title: 'x', collection: 'customer-newco' }],
          ['journal_append', { entry: 'x', collection: 'customer-newco' }],
          ['collection_create', { name: 'customer-newco' }],
        ] as const) {
          await expect(call(tool, args), tool).rejects.toThrow(/Refused: "customer-newco" does not exist here/);
        }
        expect((await listCollections()).map(c => c.name)).not.toContain('customer-newco');
        const ok = await call('memory_store', { content: 'x', collection: 'private-newco' });
        expect(ok.content[0].text).toMatch(/^Stored memory/);
      } finally {
        back();
      }
    });

    it('still writes to shared collections that exist, and refuses a new one in follow_ups before closing', async () => {
      const id = await createTask('existing work', {}, 'project-existing');
      outside();
      try {
        expect((await call('task_create', { title: 'more', collection: 'project-existing' })).content[0].text).toMatch(/^Created task/);
        await expect(call('task_complete', { id, follow_ups: [{ title: 'next', collection: 'project-brandnew' }] })).rejects.toThrow(/Refused/);
        expect((await getTask(id))?.status).not.toBe('done');
      } finally {
        back();
      }
    });

    it('may create shared collections once the user allows its folder with the scope tool', async () => {
      outside();
      try {
        const shown = await call('scope', { action: 'show' });
        expect(shown.content[0].text).toMatch(/may not create new shared collections/);
        await call('scope', { action: 'map', dir: join(dir, 'home'), collection: 'project-home' });
        expect((await call('collection_create', { name: 'project-home' })).content[0].text).toBe('Created collection "project-home"');
        await expect(call('collection_create', { name: 'project-other' })).rejects.toThrow(/Refused/);
      } finally {
        back();
      }
    });
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

  it('memory_store records a typed memory; memory_update records the choice; waiting lists it until then', async () => {
    const stored = await call('memory_store', {
      content: 'Retry forever or give up after a minute?', collection: 'project-typed',
      kind: 'decision', status: 'needed', owner: 'tester', options: ['retry forever', 'give up after 60 s'], recommendation: 'give up after 60 s',
    });
    expect(stored.content[0].text).toMatch(/^Stored memory: (mem-\S+) \[decision, needed, for tester\]/);
    const id = stored.content[0].text.match(/(mem-\S+)/)[1];

    const bad = await call('memory_store', { content: 'x', collection: 'project-typed', kind: 'decision', status: 'needed', options: ['one'] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/two options/);

    const waiting = await call('waiting', {});
    expect(waiting.content[0].text).toContain(`**${id}** (project-typed) [decision needed, for tester`);

    const listed = await call('memory_list', { collection: 'project-typed', kind: 'decision', status: 'needed' });
    expect(listed.content[0].text).toContain('[decision, needed, for tester]');

    const upd = await call('memory_update', { id, status: 'accepted', note: 'give up after 60 s' });
    expect(upd.content[0].text).toBe(`Updated ${id} in project-typed [decision, accepted, for tester]`);
    expect((await call('waiting', {})).content[0].text).toBe('Nothing is waiting on anyone.');
    expect((await call('memory_update', { id: 'mem-nope', status: 'accepted' })).isError).toBe(true);
  });

  it('write tools note the collection this session last wrote to, for the status line', async () => {
    const saved = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-lw';
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true', YAPA_SCOPE_FILE: join(dir, 'scope.json'), YAPA_SYNC_HEALTH_FILE: join(dir, 'state', 'sync-health.json') }));
    const last = () => readLastWrite('sess-lw')?.collection;
    try {
      await call('memory_store', { content: 'the lw port is 9000', collection: 'project-lw-a' });
      expect(last()).toBe('project-lw-a');
      const id = await createTask('lw task', {}, 'project-lw-b'); // straight through core: not a session write
      expect(last()).toBe('project-lw-a');
      await call('task_update', { id, notes: 'touched' }); // the task's collection, found by id
      expect(last()).toBe('project-lw-b');
      await call('memory_recall', { query: 'lw port', collection: 'project-lw-a' }); // reads change nothing
      expect(last()).toBe('project-lw-b');
      await call('task_create', { title: 'lw default' });
      expect(last()).toBe('global');
      await call('task_delete', { id });
      expect(last()).toBe('project-lw-b');
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = saved;
      setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true', YAPA_SCOPE_FILE: join(dir, 'scope.json') }));
    }
  });

  it('collection_delete: for everyone needs confirm; here only refuses while your unpushed documents cannot be pushed', async () => {
    await expect(call('collection_delete', { name: 'project-acme', scope: 'everyone' })).rejects.toThrow(/for everyone removes your documents.*collection_merge/s);
    // No sync service here: the unpushed tasks can't reach the team copy, so a local delete would lose them.
    await expect(call('collection_delete', { name: 'project-acme' })).rejects.toThrow(/could not be pushed/);
    await createNewCollection('customer-into');
    const merged = await call('collection_merge', { from: 'project-acme', into: 'customer-into', dry_run: true });
    expect(merged.content[0].text).toMatch(/^Dry run: would move 3 document/);
    const r = await call('collection_delete', { name: 'project-acme', scope: 'everyone', confirm: 'project-acme' });
    expect(r.content[0].text).toMatch(/^Deleted "project-acme" \(3 documents\) here and, for everyone, your 3 documents/);
    expect((await listCollections()).map(c => c.name)).not.toContain('project-acme');
  });
});
