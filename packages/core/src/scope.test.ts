import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the store port before importing the module under test: only
// listCollections is needed, and it must never touch a real store.
vi.mock('./store/index.js', () => ({
  listCollections: vi.fn(),
}));
// Merge redirects come from a sentinel doc in the store: stub the reader.
vi.mock('./sync/sentinel.js', async importOriginal => ({
  ...(await importOriginal<any>()),
  getCollectionRedirects: vi.fn(),
}));

import { listCollections } from './store/index.js';
import { getCollectionRedirects, resolveCollectionRedirect } from './sync/sentinel.js';
import { detectCollection, scopeNotes, isDetectionStale } from './scope.js';
import { matchCollectionMap } from './scope-file.js';
import { setConfig, resetConfig, createConfig } from './config.js';
import { looksPrivateButShared } from './sync/syncable.js';
import path, { join } from 'node:path';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const mocked = vi.mocked(listCollections);
const redirects = vi.mocked(getCollectionRedirects);
const ROOTS = ['/home/u/projects'];

/** Shorthand: a collections list carrying just the given names. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cols = (...names: string[]) => names.map(name => ({ name })) as any;

beforeEach(() => {
  mocked.mockReset();
  mocked.mockResolvedValue(cols());
  redirects.mockReset();
  redirects.mockResolvedValue({});
});

describe('detectCollection', () => {
  it('returns global without a cwd or outside all roots', async () => {
    expect((await detectCollection(undefined, ROOTS)).collection).toBe('global');
    expect((await detectCollection('/elsewhere/x', ROOTS)).collection).toBe('global');
  });

  it('returns global for dot-folders', async () => {
    expect((await detectCollection('/home/u/projects/.hidden', ROOTS)).collection).toBe('global');
  });

  it('defaults to project- when neither collection exists (the common case)', async () => {
    mocked.mockResolvedValue(cols('customer-acme', 'global'));
    expect((await detectCollection('/home/u/projects/dsh', ROOTS)).collection).toBe('project-dsh');
  });

  it('prefers an existing project- collection', async () => {
    mocked.mockResolvedValue(cols('project-dsh'));
    expect((await detectCollection('/home/u/projects/dsh', ROOTS)).collection).toBe('project-dsh');
  });

  it('prefers an existing customer- collection (established customer folders stay sticky)', async () => {
    mocked.mockResolvedValue(cols('customer-acme'));
    expect((await detectCollection('/home/u/projects/acme', ROOTS)).collection).toBe('customer-acme');
  });

  it('flags ambiguity when both exist, defaulting reads to project-', async () => {
    mocked.mockResolvedValue(cols('customer-dsh', 'project-dsh'));
    const d = await detectCollection('/home/u/projects/dsh', ROOTS);
    expect(d.collection).toBe('project-dsh');
    expect(d.ambiguous).toEqual(['project-dsh', 'customer-dsh']);
  });

  it('honors the customers config list when neither collection exists', async () => {
    expect((await detectCollection('/home/u/projects/acme', ROOTS, ['acme'])).collection).toBe('customer-acme');
    expect((await detectCollection('/home/u/projects/dsh', ROOTS, ['acme'])).collection).toBe('project-dsh');
  });

  it('uses the first path segment under the root', async () => {
    expect((await detectCollection('/home/u/projects/dsh/packages/web', ROOTS)).collection).toBe('project-dsh');
  });

  it('degrades to project- when the store is unreachable', async () => {
    mocked.mockRejectedValue(new Error('store down'));
    const d = await detectCollection('/home/u/projects/dsh', ROOTS);
    expect(d.collection).toBe('project-dsh');
    expect(d.ambiguous).toBeUndefined();
  });

  it('matches roots on a path boundary only', async () => {
    expect((await detectCollection('/home/u/projects-old/dsh', ROOTS)).collection).toBe('global');
    expect((await detectCollection('/home/u/projects', ROOTS)).collection).toBe('global');
    expect((await detectCollection('/home/u/projects/dsh', ['/home/u/projects/'])).collection).toBe('project-dsh');
  });

  it('defaults roots and customers from the scope file, and ignores the old env options', async () => {
    const base = mkdtempSync(join(tmpdir(), 'yapa-scope-file-'));
    const file = join(base, 'scope.json');
    writeFileSync(file, JSON.stringify({ project_roots: ['/srv/work', '/home/u/projects'], customers: ['acme', 'globex'] }));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    setConfig(createConfig({ YAPA_SCOPE_FILE: file, YAPA_PROJECT_ROOTS: '/elsewhere' }));
    try {
      expect((await detectCollection('/srv/work/globex/notes')).collection).toBe('customer-globex');
      expect((await detectCollection('/home/u/projects/dsh')).collection).toBe('project-dsh');
      expect((await detectCollection('/elsewhere/x')).collection).toBe('global');
      expect(err.mock.calls.map(c => String(c[0])).join('')).toMatch(/PROJECT_ROOTS is no longer read/);
    } finally {
      err.mockRestore();
      resetConfig();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('treats everything as global when the scope file is missing', async () => {
    setConfig(createConfig({ YAPA_SCOPE_FILE: join(tmpdir(), 'yapa-no-such-scope.json') }));
    try {
      expect((await detectCollection('/home/u/projects/dsh')).collection).toBe('global');
    } finally {
      resetConfig();
    }
  });
});

describe('detectCollection: collection_map', () => {
  const MAP = ['/home/u/work/acme=private-acme', '/home/u/work/acme/shared=project-acme', '/home/u/projects/dsh=local-dsh'];

  it('a mapped folder (and anything below it) wins over project roots, never ambiguous', async () => {
    mocked.mockResolvedValue(cols('customer-dsh', 'project-dsh'));
    const d = await detectCollection('/home/u/projects/dsh/src', ROOTS, [], MAP);
    expect(d).toEqual({ collection: 'local-dsh', mapped: true });
    expect((await detectCollection('/home/u/work/acme', ROOTS, [], MAP)).collection).toBe('private-acme');
  });

  it('the longest matching path wins, whatever the entry order', async () => {
    expect((await detectCollection('/home/u/work/acme/shared/docs', ROOTS, [], MAP)).collection).toBe('project-acme');
    expect((await detectCollection('/home/u/work/acme/shared/docs', ROOTS, [], [...MAP].reverse())).collection).toBe('project-acme');
    expect((await detectCollection('/home/u/work/acme/other', ROOTS, [], MAP)).collection).toBe('private-acme');
  });

  it('matches on path boundaries only, and falls back to roots otherwise', async () => {
    expect((await detectCollection('/home/u/work/acme-old', ROOTS, [], MAP)).collection).toBe('global');
    const d = await detectCollection('/home/u/projects/dshx', ROOTS, [], MAP);
    expect(d).toEqual({ collection: 'project-dshx' });
  });

  it('ignores malformed entries and tolerates trailing slashes', () => {
    expect(matchCollectionMap('/a/b', ['x', '=private-x', '/a/b='])).toBeUndefined();
    expect(matchCollectionMap('/a/b/c', ['/a/b/=private-b'])).toBe('private-b');
    expect(matchCollectionMap('/anything', ['/=local-root'])).toBe('local-root');
  });

  it('reads the scope file\'s collection_map, with ~ expanded', async () => {
    const base = mkdtempSync(join(tmpdir(), 'yapa-scope-file-'));
    const file = join(base, 'scope.json');
    writeFileSync(file, JSON.stringify({ collection_map: { '~/work/acme/': 'private-acme', '/srv/x': 'local-x' } }));
    setConfig(createConfig({ YAPA_SCOPE_FILE: file }));
    try {
      expect((await detectCollection(`${process.env.HOME}/work/acme/src`)).collection).toBe('private-acme');
      expect((await detectCollection('/srv/x')).collection).toBe('local-x');
    } finally {
      resetConfig();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('collection_map paths', () => {
  const noReal = { realpath: () => undefined };

  it('keeps a ":" or "," inside a path', async () => {
    const map = ['/srv/a:b/acme=private-acme', '/srv/c,d=local-cd'];
    expect(matchCollectionMap('/srv/a:b/acme/src', map, noReal)).toBe('private-acme');
    expect(matchCollectionMap('/srv/c,d', map, noReal)).toBe('local-cd');
    expect(matchCollectionMap('/srv/a', map, noReal)).toBeUndefined();
  });

  it('matches Windows paths on backslash boundaries, case-insensitively', () => {
    const win = { path: path.win32, realpath: () => undefined };
    const map = ['C:\\work\\acme\\=private-acme', 'C:\\work\\acme\\shared=project-acme'];
    expect(matchCollectionMap('C:\\work\\acme\\src', map, win)).toBe('private-acme');
    expect(matchCollectionMap('c:\\Work\\ACME\\src', map, win)).toBe('private-acme');
    expect(matchCollectionMap('C:/work/acme/shared/docs', map, win)).toBe('project-acme');
    expect(matchCollectionMap('C:\\work\\acme-old', map, win)).toBeUndefined();
  });

  it('follows symlinks on both sides: a linked cwd, or an entry naming a link', () => {
    const links: Record<string, string> = { '/home/u/acme-link': '/data/acme', '/home/u/acme-link/src': '/data/acme/src' };
    const realpath = (p: string) => links[p] ?? (p.startsWith('/data/') ? p : undefined);
    expect(matchCollectionMap('/home/u/acme-link/src', ['/data/acme=private-acme'], { realpath })).toBe('private-acme');
    expect(matchCollectionMap('/data/acme/src', ['/home/u/acme-link=private-acme'], { realpath })).toBe('private-acme');
    expect(matchCollectionMap('/home/u/other', ['/data/acme=private-acme'], { realpath })).toBeUndefined();
  });

  it('follows a real symlinked cwd on disk', () => {
    const base = mkdtempSync(join(tmpdir(), 'yapa-scope-'));
    try {
      mkdirSync(join(base, 'real', 'acme', 'src'), { recursive: true });
      symlinkSync(join(base, 'real', 'acme'), join(base, 'link'));
      const realBase = realpathSync(base);
      expect(matchCollectionMap(join(base, 'link', 'src'), [`${join(realBase, 'real', 'acme')}=private-acme`])).toBe('private-acme');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('says in the scope line when a mapped name looks private but syncs', async () => {
    for (const n of ['Private-acme', 'LOCAL-x', 'private_acme', 'priv-acme', 'local_x']) expect(looksPrivateButShared(n)).toBe(true);
    for (const n of ['private-acme', 'local-x', 'project-acme', 'global', 'localization-team']) expect(looksPrivateButShared(n)).toBe(false);
    const d = await detectCollection('/w/x', ROOTS, [], ['/w/x=Private-acme']);
    expect(scopeNotes(d)).toMatch(/shared: this name syncs/);
    expect(scopeNotes({ collection: 'Private-acme' })).toBe('');
  });

  it('a broad entry overrides every project root below it', async () => {
    expect((await detectCollection('/home/u/projects/acme', ROOTS, [], ['/home/u=local-me'])).collection).toBe('local-me');
  });
});

describe('detectCollection: merge redirects', () => {
  it('follows a redirect from the folder\'s collection and reports where it came from', async () => {
    redirects.mockResolvedValue({ 'project-acme': 'private-acme' });
    expect(await detectCollection('/home/u/projects/acme', ROOTS)).toEqual({ collection: 'private-acme', redirectedFrom: 'project-acme' });
  });

  it('keeps a merged-away customer- folder sticky, then follows it', async () => {
    redirects.mockResolvedValue({ 'customer-acme': 'private-acme' });
    expect((await detectCollection('/home/u/projects/acme', ROOTS)).collection).toBe('private-acme');
  });

  it('follows mapped collections and chains, and stops at a cycle', async () => {
    redirects.mockResolvedValue({ 'private-a': 'private-b', 'private-b': 'private-c' });
    expect(await detectCollection('/w/a', ROOTS, [], ['/w/a=private-a'])).toEqual({ collection: 'private-c', mapped: true, redirectedFrom: 'private-a' });
    expect(resolveCollectionRedirect('x', { x: 'y', y: 'x' })).toEqual({ collection: 'y', redirectedFrom: 'x' });
    expect(resolveCollectionRedirect('x', { x: 'x' })).toEqual({ collection: 'x' });
    expect(resolveCollectionRedirect('z', { x: 'y' })).toEqual({ collection: 'z' });
  });

  it('resolves both ambiguity candidates, and drops the ambiguity when they meet', async () => {
    mocked.mockResolvedValue(cols('customer-acme', 'project-acme'));
    redirects.mockResolvedValue({ 'customer-acme': 'project-acme' });
    expect(await detectCollection('/home/u/projects/acme', ROOTS)).toEqual({ collection: 'project-acme' });
  });

  it('never redirects global', async () => {
    redirects.mockResolvedValue({ global: 'private-x' });
    expect((await detectCollection('/elsewhere', ROOTS)).collection).toBe('global');
  });
});

describe('isDetectionStale (a host that caches a detection)', () => {
  it('is stale once the collection is merged away, or the redirect it followed is dropped', async () => {
    redirects.mockResolvedValue({});
    expect(await isDetectionStale({ collection: 'project-acme' })).toBe(false);
    redirects.mockResolvedValue({ 'project-acme': 'private-acme' });
    expect(await isDetectionStale({ collection: 'project-acme' })).toBe(true);
    expect(await isDetectionStale({ collection: 'private-acme', redirectedFrom: 'project-acme' })).toBe(false);
    expect(await isDetectionStale({ collection: 'project-x', ambiguous: ['project-x', 'project-acme'] })).toBe(true);
    redirects.mockResolvedValue({});
    expect(await isDetectionStale({ collection: 'private-acme', redirectedFrom: 'project-acme' })).toBe(true);
  });
});

describe('scopeNotes', () => {
  it('flags local-only scopes (not global) and redirects', () => {
    expect(scopeNotes({ collection: 'project-acme' })).toBe('');
    expect(scopeNotes({ collection: 'global' })).toBe('');
    expect(scopeNotes({ collection: 'private-acme', mapped: true })).toBe(' (local only, never synced)');
    expect(scopeNotes({ collection: 'private-acme', redirectedFrom: 'project-acme' })).toBe(' (local only, never synced) (merged from `project-acme`)');
  });
});
