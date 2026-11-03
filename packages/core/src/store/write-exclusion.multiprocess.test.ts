/**
 * Several real processes writing to one local store at once, as the MCP
 * servers, hooks and CLI calls of several Claude Code sessions on one
 * machine do: no write is lost and no ref is stored twice. (Embeddings are
 * stubbed so six processes don't each load the model.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'yapa-store-multi-'));
const bundle = join(dir, 'worker.mjs');
const PROCS = 6;
const FIELDS = ['priority', 'due_date', 'tags', 'project', 'customer', 'duration_minutes'] as const;

beforeAll(async () => {
  const entry = join(dir, 'worker.ts');
  writeFileSync(entry, `
    import { readFileSync, writeFileSync } from 'node:fs';
    import * as y from ${JSON.stringify(join(__dirname, '..', 'index.ts'))};
    const [mode, state, startAt, i] = process.argv.slice(2);
    const ids = () => JSON.parse(readFileSync(state, 'utf-8'));
    const C = 'private-acme';
    if (mode === 'setup') {
      const task = await y.createTask('shared task', {}, C);
      const deps = [];
      for (let k = 0; k < ${PROCS}; k++) deps.push(await y.createTask('dep ' + k, {}, C));
      const mem = (await y.storeMemory('the shared memory', { collection: C })).ids[0];
      writeFileSync(state, JSON.stringify({ task, deps, mem }));
      process.exit(0);
    }
    if (mode === 'check') {
      const s = ids();
      const t = await y.getTask(s.task);
      const m = (await y.getDocumentsByIds(C, [s.mem]))[0];
      const refs = await y.getDocumentsByFilter(C, { type: 'memory', external_ref: 'spec:X-1' }, 100);
      process.stdout.write(JSON.stringify({ task: t.metadata, memory: m.content, refs: refs.length }));
      process.exit(0);
    }
    const s = ids();
    while (Date.now() < Number(startAt)) await new Promise(r => setTimeout(r, 1));
    const n = Number(i);
    if (mode === 'fields') {
      const f = ${JSON.stringify(FIELDS)}[n];
      const v = { priority: 'critical', due_date: 1900000000, tags: ['t' + n], project: 'p' + n, customer: 'c' + n, duration_minutes: 42 }[f];
      await y.updateTask(s.task, { [f]: v });
    } else if (mode === 'notes') {
      await y.updateMemory(s.mem, { note: 'note-from-' + n });
    } else if (mode === 'external') {
      await y.putExternal(C, 'spec:X-1', { content: 'index entry', typed: {} });
    } else if (mode === 'deps') {
      await y.addDependency(s.task, s.deps[n]);
    }
    process.exit(0);
  `);
  await build({
    entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    external: ['@huggingface/transformers', 'pg-native'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    plugins: [{
      name: 'stub-embeddings',
      setup(b) {
        b.onResolve({ filter: /[\\/]embeddings\.js$/ }, () => ({ path: 'stub-embeddings', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `
            const vec = t => { const v = new Array(8).fill(0); for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i); const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
            export const generateEmbedding = async t => vec(t);
            export const generateEmbeddingsBatch = async ts => ts.map(vec);
            export const clearEmbeddingMemo = () => {};`,
          loader: 'js',
        }));
      },
    }],
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const state = join(dir, 'state.json');
const env = {
  ...process.env,
  VITEST: '',
  YAPA_USERNAME: 'tester',
  YAPA_SYNC_ENABLED: 'false',
  YAPA_SYNC_SERVICE_URL: '',
  YAPA_STORAGE: 'local',
  YAPA_LOCAL_STORE_PATH: join(dir, 'store'),
  YAPA_LOCAL_COORD_DIR: join(dir, 'coord'),
  YAPA_LEASE_STATE_DIR: join(dir, 'leases'),
  YAPA_SYNC_HEALTH_FILE: 'off',
  YAPA_DEVICE_ID: 'dev-test',
  YAPA_UPDATE_CHECK: 'false',
};

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bundle, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    let err = '';
    p.stdout!.on('data', d => { out += d; });
    p.stderr!.on('data', d => { err += d; });
    p.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(`worker ${args[0]} exited ${code}: ${err}`))));
  });
}

async function all(mode: string): Promise<void> {
  const startAt = String(Date.now() + 800);
  await Promise.all(Array.from({ length: PROCS }, (_, i) => run([mode, state, startAt, String(i)])));
}

describe('writes from several processes to one local store', () => {
  let after: { task: Record<string, any>; memory: string; refs: number };

  beforeAll(async () => {
    await run(['setup', state, '0', '0']);
    await all('fields');
    await all('notes');
    await all('external');
    await all('deps');
    after = JSON.parse(await run(['check', state, '0', '0']));
  }, 120_000);

  it('updates to different fields of one task all land', () => {
    expect(after.task).toMatchObject({ priority: 'critical', due_date: 1900000000 });
    for (const f of FIELDS) expect(after.task[f], f).toBeDefined();
    expect(after.task.project).toBe('p3');
    expect(after.task.customer).toBe('c4');
    expect(after.task.tags).toEqual(['t2']);
    expect(after.task.duration_minutes).toBe(42);
  });

  it('notes added to one memory at once all land', () => {
    for (let n = 0; n < PROCS; n++) expect(after.memory).toContain(`note-from-${n}`);
  });

  it('one external ref put by six processes at once is one memory', () => {
    expect(after.refs).toBe(1);
  });

  it('dependencies added to one task at once are all kept', () => {
    const deps = JSON.parse(readFileSync(state, 'utf-8')).deps as string[];
    expect([...(after.task.depends_on as string[])].sort()).toEqual([...deps].sort());
  });
});
