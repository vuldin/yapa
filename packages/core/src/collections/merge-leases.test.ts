import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore } from '../store/index.js';
import { createTask } from '../tasks/create.js';
import { updateTask } from '../tasks/update.js';
import { TaskClaimedError } from '../tasks/claim.js';
import { createNewCollection, mergeCollections, mergeReportLines } from './manage.js';
import { heldKeys, requireCoordination } from '../sync/coordination.js';
import { getCollectionRedirects, getSyncSubscriptions } from '../sync/sentinel.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-merge-leases-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_LOCAL_COORD_DIR: join(dir, 'coord'), YAPA_LEASE_STATE_DIR: join(dir, 'leases') }));
  setStore(createLocalStore(join(dir, 'store')));
});

afterAll(() => {
  resetStore();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe('merging moves your claims with the tasks', () => {
  it('a claimed task stays claimed in the target, and another session is refused there', async () => {
    await createNewCollection('private-acme-old');
    await createNewCollection('private-acme');
    const task = await createTask('Rotate the signing key', {}, 'private-acme-old');
    await updateTask(task, { status: 'in_progress' }, { session: 's1', title: 'rotation' });

    const r = await mergeCollections('private-acme-old', 'private-acme');
    expect(r.leases).toEqual({ moved: 1, kept: [] });
    expect(mergeReportLines(r).join('\n')).toContain('1 of your claims moved with their tasks to "private-acme".');

    const coord = await requireCoordination();
    const into = (await coord.leaseList('private-acme')).leases;
    expect(into.map(l => [l.key, l.holder.session, l.title])).toEqual([[task, 's1', 'rotation']]);
    expect((await coord.leaseList('private-acme-old')).leases.filter(l => !l.expired)).toEqual([]);
    expect(heldKeys('s1', 'private-acme')).toContain(task);
    expect(heldKeys('s1', 'private-acme-old')).not.toContain(task);

    await expect(updateTask(task, { status: 'in_progress' }, { session: 's2' })).rejects.toBeInstanceOf(TaskClaimedError);
  });

  it('leaves a project\'s own lease in the source collection, where its script looks for it', async () => {
    await createNewCollection('private-ops-old');
    await createNewCollection('private-ops');
    const task = await createTask('Tidy the runbook', {}, 'private-ops-old');
    await updateTask(task, { status: 'in_progress' }, { session: 's1' });
    const coord = await requireCoordination();
    await coord.leaseAcquire({ collection: 'private-ops-old', key: 'deploy:prod', session: 'script-1' });

    const r = await mergeCollections('private-ops-old', 'private-ops');
    expect(r.leases).toEqual({ moved: 1, kept: [] });
    expect((await coord.leaseList('private-ops-old')).leases.filter(l => !l.expired).map(l => l.key)).toEqual(['deploy:prod']);
    expect((await coord.leaseList('private-ops')).leases.map(l => l.key)).toEqual([task]);
  });

  it('says so when the source\'s claims could not be read', async () => {
    const { moveOwnLeases } = await import('../sync/coordination.js');
    setConfig(createConfig({
      YAPA_USERNAME: 'tester', YAPA_LOCAL_COORD_DIR: join(dir, 'coord'), YAPA_LEASE_STATE_DIR: join(dir, 'leases'),
      YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: 'http://127.0.0.1:9', YAPA_SYNC_ID_TOKEN_CMD: 'echo x.y.z',
    }));
    try {
      const r = await moveOwnLeases('project-shared-old', 'private-ops', ['tester-99']);
      expect(r.unchecked).toBe(true);
      expect(mergeReportLines({ from: 'project-shared-old', into: 'private-ops', moved: 1, byType: { task: 1 }, dryRun: false, sourceRemoved: true, teammateRowsKept: 0, ownRowsRetracted: 0, leases: r }).join('\n'))
        .toContain('could not be checked');
    } finally {
      setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_LOCAL_COORD_DIR: join(dir, 'coord'), YAPA_LEASE_STATE_DIR: join(dir, 'leases') }));
    }
  }, 30_000);
});

describe('sentinel lists under concurrent writers', () => {
  const bundle = join(__dirname, `.sentinel-bundle-${process.pid}.mjs`);
  const worker = join(__dirname, `.sentinel-worker-${process.pid}.mjs`);
  beforeAll(async () => {
    await build({
      stdin: {
        contents: `
          import { setConfig, createConfig } from '../config.js';
          import { setStore, createLocalStore } from '../store/index.js';
          export { addCollectionRedirect, addSyncSubscriptions } from '../sync/sentinel.js';
          export function setup(store, coord) {
            setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_LOCAL_COORD_DIR: coord }));
            setStore(createLocalStore(store));
          }`,
        resolveDir: __dirname, loader: 'ts',
      },
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', packages: 'external' });
  });
  afterAll(() => { rmSync(bundle, { force: true }); rmSync(worker, { force: true }); });

  it('loses no redirect or subscription when 6 processes record one each at once', async () => {
    const store = join(dir, 'store-multi');
    writeFileSync(worker, `
      const m = await import(${JSON.stringify(bundle)});
      const [store, coord, name, startAt] = process.argv.slice(2);
      m.setup(store, coord);
      while (Date.now() < Number(startAt)) await new Promise(r => setTimeout(r, 1));
      await m.addCollectionRedirect(name, 'project-target');
      await m.addSyncSubscriptions([name]);
    `);
    const startAt = Date.now() + 800;
    await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [worker, store, join(dir, 'coord'), `project-old-${i}`, String(startAt)], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr!.on('data', d => { err += d; });
      p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${err}`))));
    })));
    setStore(createLocalStore(store));
    try {
      const names = Array.from({ length: 6 }, (_, i) => `project-old-${i}`).sort();
      expect(Object.keys(await getCollectionRedirects()).sort()).toEqual(names);
      expect([...(await getSyncSubscriptions())].sort()).toEqual(names);
    } finally {
      setStore(createLocalStore(join(dir, 'store')));
    }
  }, 30_000);
});
