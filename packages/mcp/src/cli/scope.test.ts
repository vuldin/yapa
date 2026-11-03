import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, createLocalStore, resetConfig, resetStore, setConfig, setStore } from '@yapa/core';
import { runScope } from './scope.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-scope-cli-'));
  setConfig(createConfig({ YAPA_PROJECT_ROOTS: join(dir, 'work'), YAPA_COLLECTION_MAP: `${join(dir, 'personal')}=private-acme` }));
  setStore(createLocalStore(join(dir, 'store')));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('yapa scope', () => {
  it('names the mapped collection and says it is local only', async () => {
    const r = await runScope(['--cwd', join(dir, 'personal', 'notes')]);
    expect(r.json).toMatchObject({ ok: true, collection: 'private-acme', local_only: true, mapped: true });
    expect(r.text).toBe('private-acme (local only)');
  });

  it('a folder under project_roots gets its shared collection; elsewhere global', async () => {
    expect((await runScope(['--cwd', join(dir, 'work', 'acme')])).json).toMatchObject({ collection: 'project-acme', local_only: false, mapped: false });
    expect((await runScope([], join(dir, 'elsewhere'))).text).toBe('global (local only)');
  });
});
