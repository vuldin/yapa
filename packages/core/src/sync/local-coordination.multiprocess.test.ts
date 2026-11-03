/**
 * Several real processes sharing one coordination folder, as the MCP servers,
 * hooks and CLI calls of several Claude Code sessions on one machine do: one
 * key is granted to exactly one of them, and counters and task ids never
 * repeat, with no sync service anywhere.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'yapa-coord-multi-'));
const coordBundle = join(dir, 'local-coordination.mjs');
const createBundle = join(dir, 'create.mjs');
const worker = join(dir, 'worker.mjs');
const PROCS = 6;

beforeAll(async () => {
  const common = { bundle: true, platform: 'node' as const, format: 'esm' as const, logLevel: 'silent' as const, external: ['@huggingface/transformers', 'pg-native'] };
  await build({ ...common, entryPoints: [join(__dirname, 'local-coordination.ts')], outfile: coordBundle });
  await build({ ...common, entryPoints: [join(__dirname, '..', 'tasks', 'create.ts')], outfile: createBundle });
  // All workers start at the same instant (argv startAt) to collide as much as possible.
  writeFileSync(worker, `
    import { appendFileSync } from 'node:fs';
    const [mode, out, startAt, n] = process.argv.slice(2);
    const coord = (await import(${JSON.stringify(coordBundle)})).createLocalCoordination();
    const { getNextTaskId } = await import(${JSON.stringify(createBundle)});
    while (Date.now() < Number(startAt)) await new Promise(r => setTimeout(r, 1));
    const session = 'sess-' + process.pid;
    if (mode === 'acquire') {
      const r = await coord.leaseAcquire({ collection: 'private-acme', key: 'task-1', session, scope: ['res:bench'] });
      appendFileSync(out, (r.granted ? 'granted ' : 'refused ') + session + '\\n');
    } else if (mode === 'counter') {
      for (let i = 0; i < Number(n); i++) appendFileSync(out, (await coord.counterNext('private-acme', 'FIND-2026')) + '\\n');
    } else if (mode === 'taskid') {
      for (let i = 0; i < Number(n); i++) appendFileSync(out, (await getNextTaskId()) + '\\n');
    }
  `);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function runAll(mode: string, n = 0): Promise<string[]> {
  const out = join(dir, `${mode}.log`);
  const state = mkdtempSync(join(dir, `${mode}-`));
  const startAt = Date.now() + 600;
  const env = {
    ...process.env,
    VITEST: '',
    YAPA_USERNAME: 'tester',
    YAPA_SYNC_ENABLED: 'false',
    YAPA_SYNC_SERVICE_URL: '',
    YAPA_STORAGE: 'local',
    YAPA_LOCAL_STORE_PATH: join(state, 'store'),
    YAPA_LOCAL_COORD_DIR: join(state, 'coord'),
    YAPA_LEASE_STATE_DIR: join(state, 'leases'),
    YAPA_DEVICE_ID: 'dev-test',
  };
  await Promise.all(Array.from({ length: PROCS }, () => new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, [worker, mode, out, String(startAt), String(n)], { stdio: ['ignore', 'ignore', 'pipe'], env });
    let err = '';
    p.stderr!.on('data', d => { err += d; });
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${err}`))));
  })));
  return readFileSync(out, 'utf-8').trim().split('\n');
}

describe('local coordination across processes', () => {
  it('grants one key to exactly one of six processes', async () => {
    const lines = await runAll('acquire');
    expect(lines).toHaveLength(PROCS);
    expect(lines.filter(l => l.startsWith('granted'))).toHaveLength(1);
  }, 30_000);

  it('six processes drawing 20 counter values each never get the same one', async () => {
    const values = (await runAll('counter', 20)).map(Number);
    expect(values).toHaveLength(PROCS * 20);
    expect(new Set(values).size).toBe(PROCS * 20);
    expect(Math.max(...values)).toBe(PROCS * 20);
  }, 30_000);

  it('six processes minting 10 task ids each offline never mint the same one', async () => {
    const ids = await runAll('taskid', 10);
    expect(ids).toHaveLength(PROCS * 10);
    expect(new Set(ids).size).toBe(PROCS * 10);
    expect(ids.every(id => /^tester-\d+$/.test(id))).toBe(true);
  }, 30_000);
});
