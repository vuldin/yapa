/**
 * Many processes meeting a lock left by a crashed holder at the same moment:
 * exactly one of them may be inside the section at any time, however many
 * try to break the stale lock together.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCK_HOST } from './fs-lock.js';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'yapa-lock-multi-'));
const bundle = join(dir, 'fs-lock.mjs');
const worker = join(dir, 'worker.mjs');
const PROCS = 12;
const ROUNDS = 15;

beforeAll(async () => {
  await build({ entryPoints: [join(__dirname, 'fs-lock.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  writeFileSync(worker, `
    import { appendFileSync } from 'node:fs';
    const { withFileLock } = await import(${JSON.stringify(bundle)});
    const [lock, log, startAt] = process.argv.slice(2);
    while (Date.now() < Number(startAt)) await new Promise(r => setTimeout(r, 1));
    await withFileLock(lock, async () => {
      appendFileSync(log, 'in ' + process.hrtime.bigint() + '\\n');
      await new Promise(r => setTimeout(r, 30));
      appendFileSync(log, 'out ' + process.hrtime.bigint() + '\\n');
    }, { waitMs: 20_000 });
  `);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));


describe('breaking a stale lock under contention', () => {
  it(`never lets two of ${PROCS} processes in at once (${ROUNDS} rounds, each starting from a dead holder's lock)`, async () => {
    let worst = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const lock = join(dir, `r${round}.lock`);
      const log = join(dir, `r${round}.log`);
      // Left by a holder that died (no such pid on this host).
      writeFileSync(lock, JSON.stringify({ pid: 2 ** 30, host: LOCK_HOST, at: Date.now() - 1000 }));
      const startAt = Date.now() + 400;
      await Promise.all(Array.from({ length: PROCS }, () => new Promise<void>((resolve, reject) => {
        const p = spawn(process.execPath, [worker, lock, log, String(startAt)], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr!.on('data', d => { err += d; });
        p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${err}`))));
      })));
      // hrtime is per process, so order by the log's own sequence: appends
      // are made inside the section, one line each.
      const lines = readFileSync(log, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(PROCS * 2);
      let inside = 0;
      for (const l of lines) {
        inside += l.startsWith('in ') ? 1 : -1;
        worst = Math.max(worst, inside);
      }
    }
    expect(worst).toBe(1);
  }, 120_000);
});
