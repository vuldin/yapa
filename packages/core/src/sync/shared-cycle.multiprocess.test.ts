/**
 * Several real processes sharing one state folder, as the MCP servers of
 * several Claude Code sessions do: together they run about one cycle per
 * interval, and a holder killed mid-cycle does not stop the others.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'yapa-multi-'));
const bundle = join(dir, 'shared-cycle.mjs');
const worker = join(dir, 'worker.mjs');
const INTERVAL = 1000;

beforeAll(async () => {
  await build({
    entryPoints: [join(__dirname, 'shared-cycle.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  });
  // A stand-in for a server's timer: tick every ~100 ms (jittered), and run a
  // 150 ms "cycle" when due and the lock is free. Each cycle is appended to a log.
  writeFileSync(worker, `
    import { appendFileSync } from 'node:fs';
    const m = await import(${JSON.stringify(bundle)});
    const [log, hangMs] = process.argv.slice(2);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (;;) {
      await sleep(80 + Math.random() * 40);
      if (!m.shouldRunCycle()) continue;
      const release = m.tryAcquireCycle();
      if (!release) continue;
      const startedAt = Date.now();
      appendFileSync(log, process.pid + ' ' + startedAt + '\\n');
      await sleep(Number(hangMs) || 150);
      m.recordCycle({ startedAt, ok: true });
      release();
    }
  `);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function start(log: string, stateDir: string, hangMs = 0): ChildProcess {
  return spawn(process.execPath, [worker, log, String(hangMs)], {
    stdio: 'ignore',
    env: {
      ...process.env,
      VITEST: '',
      YAPA_SYNC_HEALTH_FILE: join(stateDir, 'sync-health.json'),
      YAPA_SYNC_SERVICE_URL: 'https://sync.example.com',
      YAPA_SYNC_INTERVAL_MS: String(INTERVAL),
    },
  });
}

const lines = (log: string) => {
  try {
    return readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

describe('six servers on one machine', () => {
  it('run about one cycle per interval between them, not six', async () => {
    const state = join(dir, 'a');
    const log = join(dir, 'a.log');
    const kids = Array.from({ length: 6 }, () => start(log, state));
    await new Promise(r => setTimeout(r, 6000));
    kids.forEach(k => k.kill('SIGKILL'));
    const n = lines(log).length;
    // Uncoordinated, six servers at a 1 s interval would run ~36 cycles in 6 s.
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(9);
    // And never two at once (no overlap between start times closer than a cycle).
    const starts = lines(log).map(l => Number(l.split(' ')[1])).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(150);
  }, 15_000);

  it('a holder killed mid-cycle leaves a lock the others take over', async () => {
    const state = join(dir, 'b');
    const log = join(dir, 'b.log');
    // One server that "hangs" in its cycle, then dies holding the lock.
    const hung = start(log, state, 60_000);
    // Wait for its cycle to start (a fixed delay is too short on a loaded machine).
    for (let t = 0; t < 5000 && lines(log).length < 1; t += 50) await new Promise(r => setTimeout(r, 50));
    expect(lines(log).length).toBe(1);
    expect(readdirSync(state).some(f => f.endsWith('.lock'))).toBe(true);
    hung.kill('SIGKILL');
    await new Promise(r => hung.once('exit', r));
    const kids = Array.from({ length: 3 }, () => start(log, state));
    await new Promise(r => setTimeout(r, 2500));
    kids.forEach(k => k.kill('SIGKILL'));
    // The dead pid's lock was taken over: cycles resumed.
    expect(lines(log).length).toBeGreaterThanOrEqual(2);
  }, 15_000);
});
