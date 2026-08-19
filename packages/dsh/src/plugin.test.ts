import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the core before importing the plugin modules that use it.
vi.mock('@yapa/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@yapa/core')>();
  return {
    ...actual,
    setConfig: vi.fn(),
    getConfig: vi.fn(() => actual.createConfig({})),
    createTask: vi.fn(async (title: string) => 'user-7'),
    parseRelativeDate: actual.parseRelativeDate,
  };
});

import { resolveConfig, PLUGIN_DEFAULTS } from './config.js';
import { RULES_TEXT } from './rules.js';

describe('resolveConfig', () => {
  it('applies plugin defaults for unset knobs', () => {
    const r = resolveConfig({});
    expect(r).toMatchObject(PLUGIN_DEFAULTS);
  });

  it('gives cordis config precedence over env-derived core defaults', () => {
    const r = resolveConfig({ chromaUrl: 'http://example:9999', username: 'ada' });
    expect(r.core.CHROMA_URL).toBe('http://example:9999');
    expect(r.core.USERNAME).toBe('ada');
  });

  it('gives the settings layer precedence over the cordis config', () => {
    const r = resolveConfig({ chromaUrl: 'http://a:1' }, { chromaUrl: 'http://b:2' });
    expect(r.core.CHROMA_URL).toBe('http://b:2');
  });

  it('ignores undefined settings fields (inherits lower layers)', () => {
    const r = resolveConfig({ username: 'ada' }, { username: undefined, chromaUrl: 'http://c:3' });
    expect(r.core.USERNAME).toBe('ada');
    expect(r.core.CHROMA_URL).toBe('http://c:3');
  });
});

describe('rules prompt section', () => {
  it('teaches the todo/goal/schedule/yapa-task boundary', () => {
    expect(RULES_TEXT).toContain('todo_write');
    expect(RULES_TEXT).toContain('create_goal');
    expect(RULES_TEXT).toContain('schedule_create');
    expect(RULES_TEXT).toContain('yapa_task_create');
  });

  it('uses yapa_-prefixed tool names throughout', () => {
    expect(RULES_TEXT).not.toMatch(/`memory_recall`/);
    expect(RULES_TEXT).toContain('yapa_memory_recall');
    expect(RULES_TEXT).toContain('yapa_memory_store');
  });

  it('disambiguates memory compaction from context compaction', () => {
    expect(RULES_TEXT).toMatch(/not context compaction/i);
  });
});

describe('tool registration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers the Phase-1 tool set with yapa_ prefixes', async () => {
    const registered: { name: string }[] = [];
    const fakeCtx = {
      tools: { register: (def: { name: string }) => { registered.push(def); return () => {}; } },
    };
    const { registerTools } = await import('./tools.js');
    registerTools(fakeCtx as any);

    const names = registered.map(d => d.name).sort();
    expect(names).toEqual([
      'yapa_collection_create', 'yapa_collection_delete', 'yapa_collection_list',
      'yapa_compaction_apply', 'yapa_compaction_suggest', 'yapa_decay_sweep',
      'yapa_journal_append', 'yapa_journal_consolidate', 'yapa_journal_list_drafts',
      'yapa_memory_forget', 'yapa_memory_list', 'yapa_memory_recall', 'yapa_memory_store',
      'yapa_status', 'yapa_task_add_dependency', 'yapa_task_complete', 'yapa_task_create',
      'yapa_task_delete', 'yapa_task_get', 'yapa_task_list', 'yapa_task_search', 'yapa_task_update',
    ].sort());
  });

  it('task_create parses relative due dates and returns a structured value', async () => {
    const registered = new Map<string, any>();
    const fakeCtx = {
      tools: { register: (def: any) => { registered.set(def.name, def); return () => {}; } },
    };
    const { registerTools } = await import('./tools.js');
    registerTools(fakeCtx as any);

    const def = registered.get('yapa_task_create');
    const exec = { signal: new AbortController().signal } as any;
    const value = await def.execute({ title: 'Write tests', due: 'tomorrow' }, exec);
    expect(value.id).toBe('user-7');
    expect(value.title).toBe('Write tests');
    expect(typeof value.due_date).toBe('number');

    const rendered = def.output.render({ title: 'Write tests' }, value);
    expect(rendered[0].text).toContain('Created task user-7');
  });
});
