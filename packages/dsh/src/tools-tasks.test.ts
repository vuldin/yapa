import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, createLocalStore, getTask, resetConfig, resetStore, setConfig, setStore } from '@yapa/core';
import { registerTools } from './tools.js';

let dir: string;
const tools = new Map<string, any>();
const exec = { signal: new AbortController().signal } as any;
const run = async (name: string, args: Record<string, any>) => {
  const def = tools.get(name);
  const value = await def.execute(args, exec);
  return { value, text: def.output.render(args, value)[0].text as string };
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-dsh-tasks-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester' }));
  setStore(createLocalStore(join(dir, 'store')));
  registerTools({ tools: { register: (def: any) => { tools.set(def.name, def); return () => {}; } } } as any);
});
afterAll(() => {
  resetStore();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe('DSH recurring tasks', () => {
  const C = 'private-chores';

  it('declares the recurrence params', () => {
    const create = tools.get('yapa_task_create').parameters.properties;
    expect(create.recurrence_pattern.enum).toEqual(['daily', 'weekly', 'monthly', 'quarterly', 'yearly']);
    expect(create.recurrence_interval).toBeDefined();
    expect(create.lead_days).toBeDefined();
    const update = tools.get('yapa_task_update').parameters.properties;
    expect(update.recurrence_pattern.enum).toContain('none');
    expect(update.series_notes).toBeDefined();
    expect(tools.get('yapa_task_list').parameters.properties.include_upcoming).toBeDefined();
  });

  it('creates, lists (upcoming hidden unless asked), updates and completes a series', async () => {
    const open = await run('yapa_task_create', { title: 'water the plants', collection: C, recurrence_pattern: 'daily' });
    expect(open.text).toMatch(/\nRepeats daily, opens on the day it is due; this occurrence is due .*, open now\.$/);
    const later = await run('yapa_task_create', { title: 'renew the domain', collection: C, recurrence_pattern: 'yearly', due: 'in 90 days', notes: 'two-year term' });
    expect(later.text).toMatch(/opens \w{3}, \w{3} \d+ \(hidden from task lists until then\)\.$/);

    const list = await run('yapa_task_list', { collection: C });
    expect(list.value.tasks.map((t: any) => t.id)).toEqual([open.value.id]);
    expect(list.value.upcoming_hidden).toBe(1);
    expect(list.text.split('\n').at(-1)).toBe('_1 upcoming recurring task(s) hidden (not open yet): pass include_upcoming: true to show them._');
    const all = await run('yapa_task_list', { collection: C, include_upcoming: true });
    expect(all.value.upcoming_hidden).toBeUndefined();
    expect(all.text).toMatch(new RegExp(`\\*\\*${later.value.id}\\*\\* .*\\(upcoming: due .*, opens \\w{3}, \\w{3} \\d+\\)`));
    expect((await run('yapa_task_list', { id: later.value.id })).text).toMatch(/Recurrence: repeats yearly, opens 30 day\(s\) before it is due; upcoming, opens/);

    const upd = await run('yapa_task_update', { id: later.value.id, lead_days: 120, series_notes: 'one-year term' });
    expect(upd.text).toMatch(/\nRepeats yearly, opens 120 day\(s\) before it is due; .*, open now\.$/);

    const done = await run('yapa_task_complete', { id: later.value.id });
    expect(done.text.split('\n')[0]).toMatch(/→ regenerated as tester-\d+ \(recurring\), due \w{3}, \w{3} \d+, opens \w{3}, \w{3} \d+$/);
    expect((await getTask(done.value.regenerated_id))?.metadata).toMatchObject({ notes: 'one-year term', previous_occurrence: later.value.id, lead_days: 120 });

    const stop = await run('yapa_task_update', { id: done.value.regenerated_id, recurrence_pattern: 'none' });
    expect(stop.text).toBe(`Updated task ${done.value.regenerated_id}\nNot recurring: completing it creates no next occurrence.`);
    expect((await run('yapa_task_complete', { id: done.value.regenerated_id })).value.regenerated_id).toBeUndefined();
  });
});
