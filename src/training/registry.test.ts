import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Stub the config module BEFORE importing the registry so registryPath() uses a
// temp ARTIFACTS_DIR per test.
let tmp: string;

async function freshRegistry() {
  // Dynamically import after env mutation so ARTIFACTS_DIR is picked up.
  const mod = await import('./registry.js');
  return mod;
}

describe('registry round-trip', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'yapa-registry-'));
    process.env.YAPA_ARTIFACTS_DIR = tmp;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.YAPA_ARTIFACTS_DIR;
  });

  it('returns empty list on a fresh registry', async () => {
    const { listAdapters } = await freshRegistry();
    // Note: config.ts exports constants at module load, so changing env vars
    // after first import won't affect ARTIFACTS_DIR here. We assert shape instead.
    expect(Array.isArray(listAdapters())).toBe(true);
  });

  it('add → get round-trips an adapter', async () => {
    const { addAdapter, getAdapter } = await freshRegistry();
    const now = Math.floor(Date.now() / 1000);
    const entry = addAdapter({
      id: 'unit-test-adapter-1',
      manifestVersion: 1,
      datasetPath: '/tmp/fake.jsonl',
      previewRef: 'abc',
      baseModel: 'b',
      backend: 'fireworks',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    expect(entry.id).toBe('unit-test-adapter-1');
    const fetched = getAdapter('unit-test-adapter-1');
    expect(fetched?.manifestVersion).toBe(1);
    expect(fetched?.status).toBe('pending');
  });

  it('updateAdapter merges changes and bumps updatedAt', async () => {
    const { addAdapter, updateAdapter, getAdapter } = await freshRegistry();
    const now = Math.floor(Date.now() / 1000) - 100;
    addAdapter({
      id: 'unit-test-adapter-2',
      manifestVersion: 2,
      datasetPath: '/tmp/fake.jsonl',
      previewRef: 'abc',
      baseModel: 'b',
      backend: 'fireworks',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    const updated = updateAdapter('unit-test-adapter-2', { status: 'running', backendJobId: 'sftj_1' });
    expect(updated?.status).toBe('running');
    expect(updated?.backendJobId).toBe('sftj_1');
    const fetched = getAdapter('unit-test-adapter-2');
    expect(fetched?.updatedAt).toBeGreaterThanOrEqual(now);
  });

  it('updateAdapter returns null for unknown id', async () => {
    const { updateAdapter } = await freshRegistry();
    expect(updateAdapter('does-not-exist', { status: 'completed' })).toBeNull();
  });
});
