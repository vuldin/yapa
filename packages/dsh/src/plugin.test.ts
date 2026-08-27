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

  it('registers the mission tool set by default (ML-ops gated off)', async () => {
    const registered: { name: string }[] = [];
    const fakeCtx = {
      tools: { register: (def: { name: string }) => { registered.push(def); return () => {}; } },
    };
    const { registerTools } = await import('./tools.js');
    const { registerAdvancedTools } = await import('./tools-advanced.js');
    registerTools(fakeCtx as any);
    registerAdvancedTools(fakeCtx as any, () => resolveConfig({}));

    const names = registered.map(d => d.name).sort();
    expect(names).toEqual([
      // memory + tasks + collections + journal + compaction + hygiene
      'yapa_collection_create', 'yapa_collection_delete', 'yapa_collection_list',
      'yapa_compaction_apply', 'yapa_compaction_suggest', 'yapa_decay_sweep',
      'yapa_journal_append', 'yapa_journal_consolidate',
      'yapa_memory_forget', 'yapa_memory_list', 'yapa_memory_recall', 'yapa_memory_store',
      'yapa_status', 'yapa_task_add_dependency', 'yapa_task_complete', 'yapa_task_create',
      'yapa_task_delete', 'yapa_task_list', 'yapa_task_search', 'yapa_task_update',
      // advanced but mission-central: janitor, consolidated sync, storage import
      'yapa_janitor_now', 'yapa_sync', 'yapa_storage_import',
    ].sort());
    expect(names.every(n => n.startsWith('yapa_'))).toBe(true);
    expect(names.length).toBe(23);
  });

  it('adds the 18 ML-ops tools when trainingPipeline is enabled', async () => {
    const registered: { name: string }[] = [];
    const fakeCtx = {
      tools: { register: (def: { name: string }) => { registered.push(def); return () => {}; } },
    };
    const { registerAdvancedTools } = await import('./tools-advanced.js');
    const dispose = registerAdvancedTools(fakeCtx as any, () => resolveConfig({ trainingPipeline: true }));

    const names = registered.map(d => d.name).sort();
    expect(names).toEqual([
      'yapa_janitor_now', 'yapa_sync', 'yapa_storage_import',
      'yapa_curation_now', 'yapa_curation_status', 'yapa_curation_preview',
      'yapa_bucket_route_preview', 'yapa_bucket_route_now', 'yapa_bucket_status',
      'yapa_system_prompt_activate', 'yapa_system_prompt_deactivate',
      'yapa_training_dataset_preview', 'yapa_training_trigger', 'yapa_training_status',
      'yapa_training_get', 'yapa_training_cancel',
      'yapa_eval_run', 'yapa_eval_compare', 'yapa_eval_verify',
      'yapa_adapter_promote', 'yapa_adapter_demote',
    ].sort());
    expect(names.length).toBe(21);

    // The returned disposer unregisters the group (hot-reload re-registration).
    dispose();
  });

  it('task_list folds in task_get: id param returns full detail', async () => {
    const registered = new Map<string, any>();
    const fakeCtx = {
      tools: { register: (def: any) => { registered.set(def.name, def); return () => {}; } },
    };
    const { registerTools } = await import('./tools.js');
    registerTools(fakeCtx as any);
    const def = registered.get('yapa_task_list');
    // defineTool wraps shorthand params into a JSON-Schema object.
    expect(def.parameters.properties.id).toBeDefined();
    expect(registered.has('yapa_task_get')).toBe(false);
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
