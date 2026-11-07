import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, createLocalStore, resetConfig, resetStore, setConfig, setStore } from '@yapa/core';
import { runScope } from './scope.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-scope-cli-'));
  writeFileSync(join(dir, 'scope.json'), JSON.stringify({ project_roots: [join(dir, 'work')], collection_map: { [join(dir, 'personal')]: 'private-acme' } }));
  setConfig(createConfig({ YAPA_SCOPE_FILE: join(dir, 'scope.json') }));
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

  it('lists and edits the folder rules, relative to the current folder', async () => {
    let r = await runScope(['add-root', 'more'], dir);
    expect(r.exit).toBe(0);
    expect(r.text).toMatch(new RegExp(`^Added project root ${join(dir, 'more')}`));
    expect(JSON.parse(readFileSync(join(dir, 'scope.json'), 'utf8')).project_roots).toContain(join(dir, 'more'));
    r = await runScope(['map', join(dir, 'solo'), 'project-solo'], dir);
    expect(r.json).toMatchObject({ ok: true, collection_map: { [join(dir, 'solo')]: 'project-solo' } });
    r = await runScope(['list', '--cwd', join(dir, 'solo')], dir);
    expect(r.text).toMatch(/may create only its mapped shared collection, project-solo/);
    expect((await runScope(['unmap', join(dir, 'solo')], dir)).text).toMatch(/^Removed the mapping/);
    expect((await runScope(['remove-root', 'more'], dir)).text).toMatch(/^Removed project root/);
  });

  it('marks and unmarks a collection that keeps its records elsewhere', async () => {
    let r = await runScope(['records-elsewhere', 'add', 'private-acme'], dir);
    expect(r.exit).toBe(0);
    expect(r.text).toMatch(/^private-acme now keeps its records elsewhere/);
    expect(r.json).toMatchObject({ records_elsewhere: ['private-acme'] });
    expect((await runScope(['list'], dir)).text).toMatch(/records_elsewhere: private-acme/);
    r = await runScope(['records-elsewhere', 'remove', 'private-acme'], dir);
    expect(r.json).toMatchObject({ records_elsewhere: [] });
    expect((await runScope(['records-elsewhere', 'frob', 'x'], dir)).exit).toBe(2);
    expect((await runScope(['records-elsewhere', 'add'], dir)).text).toMatch(/needs a collection/);
  });

  it('exits non-zero on a bad subcommand or a missing argument', async () => {
    expect((await runScope(['frobnicate'])).exit).toBe(2);
    const r = await runScope(['map', '/x']);
    expect(r).toMatchObject({ exit: 1, json: { ok: false } });
    expect(r.text).toMatch(/map needs a collection/);
  });
});
