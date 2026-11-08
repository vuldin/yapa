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
  let savedProjectDir: string | undefined;
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
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
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
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
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

    it('every other write tool refuses a new shared collection too', async () => {
      const id = await createTask('existing', {}, 'project-existing2');
      outside();
      try {
        for (const [tool, args] of [
          ['journal_consolidate', { collection: 'customer-newco' }],
          ['compaction_apply', { collection: 'customer-newco', member_ids: ['m1', 'm2'], summary: 's' }],
          ['memory_update', { id: 'mem-x', collection: 'customer-newco', note: 'n' }],
          ['task_update', { id, notes: 'note-from-outside', follow_ups: [{ title: 'next', collection: 'customer-newco' }] }],
        ] as const) {
          await expect(call(tool, args), tool).rejects.toThrow(/Refused: "customer-newco" does not exist here/);
        }
        expect(String((await getTask(id))?.metadata.notes ?? '')).not.toContain('note-from-outside');
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

  it('in a records-elsewhere collection: memory_store keeps a kind as a note, the scope tool marks it, decision_needed is refused', async () => {
    const marked = await call('scope', { action: 'add_records_elsewhere', collection: 'private-recs' });
    expect(marked.content[0].text).toMatch(/^private-recs now keeps its records elsewhere/);
    const stored = await call('memory_store', { content: 'the recs gateway caps at 4 MB', collection: 'private-recs', kind: 'finding' });
    expect(stored.content[0].text).toMatch(/^Stored memory: mem-\S+\nKept as a note, without the kind finding: this collection keeps its records/);
    const id = stored.content[0].text.match(/(mem-\S+)/)[1];
    const upd = await call('memory_update', { id, kind: 'finding' });
    expect(upd.isError).toBe(true);
    expect(upd.content[0].text).toMatch(/^Refused: giving .* a kind in private-recs/);
    const task = (await call('task_create', { title: 'recs rollout', collection: 'private-recs' })).content[0].text.match(/(tester-\d+)/)[1];
    const dec = await call('task_update', { id: task, decision_needed: { question: 'Ship?', options: ['yes', 'no'] } });
    expect(dec.isError).toBe(true);
    expect(dec.content[0].text).toMatch(/set the task to blocked/);
    const done = await call('task_complete', { id: task, learned: [{ content: 'recs needs TLS 1.3', kind: 'limitation' }] });
    expect(done.content[0].text).toMatch(/Kept mem-\S+ as a note, without a kind/);
    await call('scope', { action: 'remove_records_elsewhere', collection: 'private-recs' });
  });

  it('recurring tasks: created, listed (upcoming hidden unless asked), changed, stopped, and regenerated with dates', async () => {
    const C = 'project-recurring';
    const idOf = (r: any) => r.content[0].text.match(/(tester-\d+)/)[1];
    expect((await call('task_create', { title: 'x', collection: C, is_recurring: true })).isError).toBe(true);
    expect(() => z.object(tools.get('task_create')!.schema).parse({ title: 'x', recurrence_pattern: 'hourly' })).toThrow();

    const daily = await call('task_create', { title: 'check the backups', collection: C, recurrence_pattern: 'daily' });
    expect(daily.content[0].text).toMatch(/\nRepeats daily, opens on the day it is due; this occurrence is due .*, open now\.$/);
    const later = await call('task_create', { title: 'file the quarterly report', collection: C, recurrence_pattern: 'quarterly', due: 'in 60 days', notes: 'figures, review' });
    expect(later.content[0].text).toMatch(/Repeats quarterly, opens 14 day\(s\) before it is due; .*, opens \w{3}, \w{3} \d+ \(hidden from task lists until then\)\.$/);
    const laterId = idOf(later);

    const listed = (await call('task_list', { collection: C })).content[0].text;
    expect(listed).toContain(idOf(daily));
    expect(listed).not.toContain(laterId);
    expect(listed.split('\n').at(-1)).toBe('_1 upcoming recurring task(s) hidden (not open yet): pass include_upcoming: true to show them._');
    const all = (await call('task_list', { collection: C, include_upcoming: true })).content[0].text;
    expect(all).toMatch(new RegExp(`\\*\\*${laterId}\\*\\* .*\\(upcoming: due .*, opens \\w{3}, \\w{3} \\d+\\)`));
    expect(all).not.toMatch(/hidden/);
    const one = (await call('task_list', { id: laterId })).content[0].text;
    expect(one).toMatch(/Recurrence: repeats quarterly, opens 14 day\(s\) before it is due; upcoming: due/);
    expect(one).toContain(`Series: series ${laterId}`);

    const upd = await call('task_update', { id: laterId, lead_days: 90, series_notes: 'figures, review, archive' });
    expect(upd.content[0].text).toMatch(/\nRepeats quarterly, opens 90 day\(s\) before it is due; this occurrence is due .*, open now\.$/);
    expect(() => z.object(tools.get('task_update')!.schema).parse({ id: laterId, recurrence_interval: 0 })).toThrow();
    const cleared = await call('task_update', { id: laterId, due: 'none' });
    expect(cleared.isError).toBe(true);
    expect(cleared.content[0].text).toMatch(/needs a due date/);

    const done = await call('task_complete', { id: laterId });
    expect(done.content[0].text.split('\n')[0]).toMatch(new RegExp(`^Completed task ${laterId} → regenerated as (tester-\\d+) \\(recurring\\), due \\w{3}, \\w{3} \\d+, opens \\w{3}, \\w{3} \\d+$`));
    const nextId = done.content[0].text.match(/regenerated as (tester-\d+)/)[1];
    expect((await getTask(nextId))?.metadata).toMatchObject({ notes: 'figures, review, archive', recurrence_series: laterId, previous_occurrence: laterId, lead_days: 90 });

    const stop = await call('task_update', { id: nextId, recurrence_pattern: 'none' });
    expect(stop.content[0].text).toBe(`Updated task ${nextId}\nNot recurring: completing it creates no next occurrence.`);
    expect((await call('task_complete', { id: nextId })).content[0].text.split('\n')[0]).toBe(`Completed task ${nextId}`);

    const plain = await createTask('back up the laptop', {}, C);
    const set = await call('task_update', { id: plain, recurrence_pattern: 'weekly', recurrence_interval: 2 });
    expect(set.content[0].text).toMatch(/\nRepeats every 2 weeks, opens 2 day\(s\) before it is due; this occurrence is due .*, open now\.$/);
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
