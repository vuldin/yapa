import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createConfig, createLocalStore, editScopeSettings, resetConfig, resetStore, setConfig, setStore } from '@yapa/core';
import { registerInjector } from './injector.js';
import { resolveConfig } from './config.js';

let dir: string;
let preStep: (event: any, next: () => Promise<any>) => Promise<any>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-dsh-injector-'));
  writeFileSync(join(dir, 'scope.json'), JSON.stringify({ project_roots: [join(dir, 'projects')] }));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SCOPE_FILE: join(dir, 'scope.json') }));
  setStore(createLocalStore(join(dir, 'store')));
  const ctx = { on: (name: string, fn: any) => { if (name === 'agent/pre-step') preStep = fn; } };
  registerInjector(ctx as any, () => resolveConfig({ injectTasks: false }));
});
afterAll(() => {
  resetStore();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

async function scopeLine(agent: any, text: string): Promise<string | undefined> {
  const prompt = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } as any });
  const decision = await preStep({ agent, messages: [prompt], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [prompt] }));
  const injected = decision.messages.find((m: any) => m.source?.plugin === 'yapa');
  const body = injected?.content.map((c: any) => c.text).join('') ?? '';
  return body.split('\n').find((l: string) => l.startsWith('**Scope:**'));
}

describe('the DSH injector', () => {
  it('re-detects the session\'s collection when the folder rules change mid-session', async () => {
    const cwd = join(dir, 'projects', 'acme');
    const agent = { id: 'agent-1', session: { id: 's1', header: { cwd } } };
    expect(await scopeLine(agent, 'where is the staging config?')).toBe('**Scope:** `project-acme`');
    await editScopeSettings({ op: 'map', dir: cwd, collection: 'private-x' });
    expect(await scopeLine(agent, 'and the prod config?')).toBe('**Scope:** `private-x` (local only, never synced)');
  });
});
