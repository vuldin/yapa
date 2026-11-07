import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, resetConfig, setConfig } from './config.js';
import { createLocalStore, resetStore, setStore, getOrCreateCollection } from './store/index.js';
import {
  editScopeSettings, mayCreateSharedFrom, readScopeSettings, ScopeFileError, SharedCollectionNotAllowedError, sessionFolder,
} from './scope-file.js';
import { runScopeAction } from './scope.js';
import { assertMayCreateCollection, addLeftCollection, resolveWriteCollection } from './sync/sentinel.js';
import { storeMemory } from './memory/store.js';
import { createTask } from './tasks/create.js';

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-scope-file-'));
  setStore(createLocalStore(join(dir, 'store')));
});
afterAll(() => {
  resetStore();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});
let n = 0;
beforeEach(() => {
  file = join(dir, `scope-${++n}.json`);
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SCOPE_FILE: file }));
});

describe('the scope file', () => {
  it('is empty when missing, and edits create it with tidy, sorted entries', async () => {
    expect(readScopeSettings()).toEqual({ project_roots: [], customers: [], collection_map: {} });
    await editScopeSettings({ op: 'add_root', dir: '~/work/' });
    await editScopeSettings({ op: 'add_root', dir: 'sub/../projects', }, { base: '/srv' });
    await editScopeSettings({ op: 'add_customer', name: ' globex ' });
    const r = await editScopeSettings({ op: 'map', dir: '/srv/acme/', collection: 'private-acme' });
    expect(r.changed).toBe(true);
    expect(readScopeSettings()).toEqual({
      project_roots: [`${homedir()}/work`, '/srv/projects'].sort(),
      customers: ['globex'],
      collection_map: { '/srv/acme': 'private-acme' },
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(readScopeSettings());
  });

  it('reports no change for a repeated add or a missing remove', async () => {
    expect((await editScopeSettings({ op: 'add_root', dir: '/srv/p' })).changed).toBe(true);
    expect((await editScopeSettings({ op: 'add_root', dir: '/srv/p/' })).changed).toBe(false);
    expect((await editScopeSettings({ op: 'remove_root', dir: '/srv/q' })).changed).toBe(false);
    expect((await editScopeSettings({ op: 'unmap', dir: '/srv/q' })).changed).toBe(false);
    expect((await editScopeSettings({ op: 'remove_root', dir: '/srv/p' })).changed).toBe(true);
    expect(readScopeSettings().project_roots).toEqual([]);
  });

  it('sees a change made by another process on the next read', async () => {
    writeFileSync(file, JSON.stringify({ project_roots: ['/a'] }));
    expect(readScopeSettings().project_roots).toEqual(['/a']);
    writeFileSync(file, JSON.stringify({ project_roots: ['/b'] }));
    expect(readScopeSettings().project_roots).toEqual(['/b']);
  });

  it('treats an invalid file as no rules when reading, and refuses to edit it', async () => {
    writeFileSync(file, '{"project_roots": "/srv"');
    expect(readScopeSettings()).toEqual({ project_roots: [], customers: [], collection_map: {} });
    expect(() => readScopeSettings({ strict: true })).toThrow(ScopeFileError);
    await expect(editScopeSettings({ op: 'add_root', dir: '/srv' })).rejects.toThrow(/not valid JSON/);
    writeFileSync(file, JSON.stringify({ project_roots: ['relative/dir'] }));
    expect(() => readScopeSettings({ strict: true })).toThrow(/must be an absolute path/);
  });

  it('refuses invalid names, and warns about a mapped name that looks private but syncs', async () => {
    await expect(editScopeSettings({ op: 'map', dir: '/srv/a', collection: 'x' })).rejects.toThrow(/not a valid collection name/);
    await expect(editScopeSettings({ op: 'add_customer', name: 'a/b' })).rejects.toThrow(/not a folder name/);
    const r = await editScopeSettings({ op: 'map', dir: '/srv/a', collection: 'Private-acme' });
    expect(r.warning).toMatch(/"Private-acme" is a shared collection name and syncs/);
  });
});

describe('which folders may create a new shared collection', () => {
  beforeEach(async () => {
    await editScopeSettings({ op: 'add_root', dir: '/home/u/projects' });
    await editScopeSettings({ op: 'map', dir: '/home/u/work/acme', collection: 'project-acme' });
    await editScopeSettings({ op: 'map', dir: '/home/u/projects/acme-notes', collection: 'private-acme' });
  });

  it('a folder at or under a project root may create any; a mapped folder only its own', () => {
    expect(mayCreateSharedFrom('/home/u/projects', 'customer-globex')).toBe(true);
    expect(mayCreateSharedFrom('/home/u/projects/api/src', 'project-other')).toBe(true);
    expect(mayCreateSharedFrom('/home/u/projects-old/api', 'project-api')).toBe(false);
    expect(mayCreateSharedFrom('/home/u/work/acme/src', 'project-acme')).toBe(true);
    expect(mayCreateSharedFrom('/home/u/work/acme/src', 'project-other')).toBe(false);
    expect(mayCreateSharedFrom('/home/u', 'project-acme')).toBe(false);
    expect(mayCreateSharedFrom('/home/u', 'private-anything')).toBe(true);
    expect(mayCreateSharedFrom('/home/u', 'global')).toBe(true);
  });

  it('writes from a session outside them are refused, before anything is written', async () => {
    const folder = '/home/u';
    await expect(resolveWriteCollection('project-newthing', { folder })).rejects.toBeInstanceOf(SharedCollectionNotAllowedError);
    await expect(resolveWriteCollection('project-newthing', { folder })).rejects.toThrow(/use a local-only collection such as "private-newthing"/i);
    expect((await resolveWriteCollection('private-newthing', { folder })).collection).toBe('private-newthing');
    expect((await resolveWriteCollection('project-newthing', { folder: '/home/u/projects/x' })).collection).toBe('project-newthing');
    expect((await resolveWriteCollection('project-newthing')).collection).toBe('project-newthing');
  });

  it('a shared collection that already exists here, or one this machine left, is never refused', async () => {
    await getOrCreateCollection('project-existing');
    await expect(assertMayCreateCollection('project-existing', '/home/u')).resolves.toBeUndefined();
    await addLeftCollection('project-gone');
    await expect(assertMayCreateCollection('project-gone', '/home/u')).resolves.toBeUndefined();
    await expect(assertMayCreateCollection('project-unknown', '/home/u')).rejects.toBeInstanceOf(SharedCollectionNotAllowedError);
  });

  it('background writes (no folder) are not checked: they go to the folder\'s own collection', async () => {
    const r = await storeMemory('a captured note', { collection: 'project-captured' });
    expect(r.ids.length).toBe(1);
    expect(await createTask('a task', {}, 'project-captured-tasks')).toMatch(/^tester-/);
  });

  it('allowing a folder takes effect on the next write', async () => {
    await expect(resolveWriteCollection('project-later', { folder: '/srv/later/x' })).rejects.toBeInstanceOf(SharedCollectionNotAllowedError);
    await editScopeSettings({ op: 'add_root', dir: '/srv/later' });
    expect((await resolveWriteCollection('project-later', { folder: '/srv/later/x' })).collection).toBe('project-later');
  });
});

describe('runScopeAction (the scope tools)', () => {
  it('shows the rules and what they mean for the session folder, and edits relative to it', async () => {
    let r = await runScopeAction({ action: 'show' }, '/home/u');
    expect(r.text).toMatch(/project_roots: \(none: every folder is "global", and no new shared collection can be created\)/);
    expect(r.text).toMatch(/\/home\/u: collection global; it may not create new shared collections/);
    r = await runScopeAction({ action: 'add_root', dir: 'projects' }, '/home/u');
    expect(r.text).toMatch(/^Added project root \/home\/u\/projects: /);
    r = await runScopeAction({ action: 'add_root', dir: '/home/u/projects' }, '/home/u');
    expect(r.text).toMatch(/^\/home\/u\/projects was already a project root\./);
    r = await runScopeAction({ action: 'show' }, '/home/u/projects/api');
    expect(r.text).toMatch(/collection project-api; it may create new shared collections/);
    r = await runScopeAction({ action: 'map', dir: '/home/u/work/acme', collection: 'project-acme' }, '/home/u');
    expect(r.text).toMatch(/Mapped \/home\/u\/work\/acme → project-acme\./);
    expect((await runScopeAction({ action: 'show' }, '/home/u/work/acme')).text).toMatch(/may create only its mapped shared collection, project-acme/);
    await expect(runScopeAction({ action: 'map', dir: '/x' }, '/home/u')).rejects.toThrow(/map needs a collection/);
  });
});

describe('sessionFolder', () => {
  it('is Claude Code\'s project folder when set, else the process folder', () => {
    expect(sessionFolder({ CLAUDE_PROJECT_DIR: '/home/u/projects/api/' })).toBe('/home/u/projects/api');
    expect(sessionFolder({})).toBe(process.cwd());
  });
});
