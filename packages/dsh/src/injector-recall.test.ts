import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createConfig, createLocalStore, resetConfig, resetStore, setConfig, setStore, storeMemory } from '@yapa/core';
import { registerInjector } from './injector.js';
import { resolveConfig } from './config.js';

let dir: string;
const handlers: Record<string, any> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-dsh-recall-'));
  writeFileSync(join(dir, 'scope.json'), JSON.stringify({ project_roots: [join(dir, 'projects')] }));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SCOPE_FILE: join(dir, 'scope.json') }));
  setStore(createLocalStore(join(dir, 'store')));
  await storeMemory('acme staging config lives in deploy/staging.yaml, owned by the platform team', { collection: 'project-acme', salience: 2 });
  registerInjector({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any, () => resolveConfig({ injectTasks: false }));
});
afterAll(() => {
  resetStore();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

const agent = () => ({ id: 'agent-r', session: { id: 'agent-r', header: { cwd: join(dir, 'projects', 'acme') } } });

async function injected(text: string): Promise<string> {
  const prompt = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } as any });
  const decision = await handlers['agent/pre-step']({ agent: agent(), messages: [prompt], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [prompt] }));
  const m = decision.messages.find((x: any) => x.source?.plugin === 'yapa');
  return m ? m.content.map((c: any) => c.text).join('') : '';
}

describe('DSH recall of hits already shown in the session', () => {
  it('names a repeat instead of showing it again, until a compaction', async () => {
    const first = await injected('where is the acme staging config?');
    expect(first).toContain('deploy/staging.yaml');
    const second = await injected('and who owns the acme staging config?');
    expect(second).not.toContain('**mem-');
    expect(second).toMatch(/Also matched, shown earlier in this session: mem-[a-z0-9-]+ \("acme staging config/);
    handlers['session/event']({ id: 'someone-else' }, { type: 'compaction/summary', data: {} });
    expect(await injected('who owns acme staging config again?')).not.toContain('**mem-');
    handlers['session/event']({ id: 'agent-r' }, { type: 'compaction/summary', data: {} });
    expect(await injected('remind me where the acme staging config is')).toContain('**mem-');
    await injected('acme staging config location?');
    handlers['session/event']({ id: 'agent-r' }, { type: 'compaction/prune', data: {} });
    expect(await injected('acme staging config, once more')).toContain('**mem-');
  });
});

describe('DSH recall when the injected context is truncated', () => {
  it('counts a hit as shown only if it made it into the message', async () => {
    const own: Record<string, any> = {};
    registerInjector({ on: (name: string, fn: any) => { own[name] = fn; } } as any, () => resolveConfig({ injectTasks: false, maxContextBytes: 120 }));
    const ask = async (text: string) => {
      const prompt = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } as any });
      const a = { id: 'agent-t', session: { id: 'agent-t', header: { cwd: join(dir, 'projects', 'acme') } } };
      const decision = await own['agent/pre-step']({ agent: a, messages: [prompt], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [prompt] }));
      const m = decision.messages.find((x: any) => x.source?.plugin === 'yapa');
      return m ? m.content.map((c: any) => c.text).join('') : '';
    };
    const first = await ask('where is the acme staging config?');
    expect(first).toContain('(truncated)');
    expect(first).not.toMatch(/\*\*mem-[a-z0-9-]+\*\*/);
    expect(await ask('where is the acme staging config?')).not.toContain('shown earlier in this session');
  });
});
