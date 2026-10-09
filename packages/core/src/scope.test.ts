import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the store port before importing the module under test: only
// listCollections is needed, and it must never touch a real store.
vi.mock('./store/index.js', () => ({
  listCollections: vi.fn(),
}));

import { listCollections } from './store/index.js';
import { detectCollection } from './scope.js';
import { setConfig, resetConfig, createConfig } from './config.js';

const mocked = vi.mocked(listCollections);
const ROOTS = ['/home/u/projects'];

/** Shorthand: a collections list carrying just the given names. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cols = (...names: string[]) => names.map(name => ({ name })) as any;

beforeEach(() => {
  mocked.mockReset();
  mocked.mockResolvedValue(cols());
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
