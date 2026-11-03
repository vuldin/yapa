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
import { detectCollection, matchCollectionMap, scopeNotes } from './scope.js';
import { setConfig, resetConfig, createConfig } from './config.js';

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

  it('defaults roots and customers from YAPA_PROJECT_ROOTS / YAPA_CUSTOMERS', async () => {
    setConfig(createConfig({ YAPA_PROJECT_ROOTS: '/srv/work:/home/u/projects', YAPA_CUSTOMERS: 'acme,globex' }));
    try {
      expect((await detectCollection('/srv/work/globex/notes')).collection).toBe('customer-globex');
      expect((await detectCollection('/home/u/projects/dsh')).collection).toBe('project-dsh');
      expect((await detectCollection('/tmp/x')).collection).toBe('global');
    } finally {
      resetConfig();
    }
  });

  it('treats everything as global when no roots are configured', async () => {
    setConfig(createConfig({}));
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

  it('reads YAPA_COLLECTION_MAP, with ~ expanded', async () => {
    setConfig(createConfig({ YAPA_COLLECTION_MAP: '~/work/acme/=private-acme, /srv/x=local-x' }));
    try {
      expect(createConfig({ YAPA_COLLECTION_MAP: '~/work/acme/=private-acme' }).COLLECTION_MAP).toEqual([`${process.env.HOME}/work/acme=private-acme`]);
      expect((await detectCollection(`${process.env.HOME}/work/acme/src`)).collection).toBe('private-acme');
      expect((await detectCollection('/srv/x')).collection).toBe('local-x');
    } finally {
      resetConfig();
    }
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

describe('scopeNotes', () => {
  it('flags local-only scopes (not global) and redirects', () => {
    expect(scopeNotes({ collection: 'project-acme' })).toBe('');
    expect(scopeNotes({ collection: 'global' })).toBe('');
    expect(scopeNotes({ collection: 'private-acme', mapped: true })).toBe(' (local only, never synced)');
    expect(scopeNotes({ collection: 'private-acme', redirectedFrom: 'project-acme' })).toBe(' (local only, never synced) (merged from `project-acme`)');
  });
});
