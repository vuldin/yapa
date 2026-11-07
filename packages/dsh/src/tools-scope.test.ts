import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, createLocalStore, listCollections, resetConfig, resetStore, setConfig, setStore } from '@yapa/core';
import { registerTools } from './tools.js';

let dir: string;
const tools = new Map<string, any>();
const execIn = (cwd: string) => ({ signal: new AbortController().signal, agent: { id: 'a1', session: { header: { cwd } } } }) as any;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-dsh-scope-'));
  writeFileSync(join(dir, 'scope.json'), JSON.stringify({ project_roots: [join(dir, 'projects')] }));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SCOPE_FILE: join(dir, 'scope.json') }));
  setStore(createLocalStore(join(dir, 'store')));
  registerTools({ tools: { register: (def: any) => { tools.set(def.name, def); return () => {}; } } } as any);
});
afterAll(() => {
  resetStore();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe('DSH tools judge the session\'s folder (its header cwd)', () => {
  it('a session outside every project root cannot create a shared collection', async () => {
    const outside = execIn(join(dir, 'home'));
    await expect(tools.get('yapa_memory_store').execute({ content: 'x', collection: 'customer-newco' }, outside))
      .rejects.toThrow(/Refused: "customer-newco" does not exist here/);
    await expect(tools.get('yapa_collection_create').execute({ name: 'customer-newco' }, outside)).rejects.toThrow(/Refused/);
    expect((await listCollections()).map(c => c.name)).not.toContain('customer-newco');
    expect((await tools.get('yapa_scope').execute({ action: 'show' }, outside)).text).toMatch(/may not create new shared collections/);
  });

  it('a collection marked as keeping its records elsewhere stores a kind as a note', async () => {
    const here = execIn(join(dir, 'home'));
    expect((await tools.get('yapa_scope').execute({ action: 'add_records_elsewhere', collection: 'private-recs' }, here)).text).toMatch(/now keeps its records elsewhere/);
    const r = await tools.get('yapa_memory_store').execute({ content: 'the recs cap is 4 MB', collection: 'private-recs', kind: 'finding' }, here);
    expect(r.label).toBeUndefined();
    expect(r.kept_as_note).toMatch(/^Kept as a note, without the kind finding/);
    await tools.get('yapa_scope').execute({ action: 'remove_records_elsewhere', collection: 'private-recs' }, here);
  });

  it('a session under a project root can', async () => {
    const inside = execIn(join(dir, 'projects', 'newco'));
    expect((await tools.get('yapa_memory_store').execute({ content: 'the newco port is 9000', collection: 'customer-newco' }, inside)).ids).toHaveLength(1);
    expect(await tools.get('yapa_collection_create').execute({ name: 'project-newco-two' }, inside)).toEqual({ name: 'project-newco-two' });
  });
});
