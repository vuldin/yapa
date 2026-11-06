/** RetentionSweeper: at most one sweep per interval, never concurrent, never throws. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLogSink } from './log.js';
import { RETENTION_SWEEP_INTERVAL_MS, RetentionSweeper } from './retention.js';

let lines: string[];
let restore: () => void;
beforeEach(() => { lines = []; restore = setLogSink(l => lines.push(l)); });
afterEach(() => restore());

describe('RetentionSweeper', () => {
  it('runs on the first request, then at most once per 5 minutes', async () => {
    let t = 1_000_000;
    let runs = 0;
    const s = new RetentionSweeper(async () => { runs++; return 3; }, undefined, () => t);
    await s.maybeSweep();
    expect(runs).toBe(1);
    expect(s.maybeSweep()).toBeUndefined();
    t += RETENTION_SWEEP_INTERVAL_MS - 1;
    expect(s.maybeSweep()).toBeUndefined();
    t += 1;
    await s.maybeSweep();
    expect(runs).toBe(2);
    expect(RETENTION_SWEEP_INTERVAL_MS).toBe(5 * 60_000);
    expect(lines.filter(l => l.includes('"event":"retention_sweep"'))).toHaveLength(2);
  });

  it('never starts a second sweep while one is running, even past the interval', async () => {
    let t = 0;
    let release!: () => void;
    let runs = 0;
    const s = new RetentionSweeper(() => { runs++; return new Promise<number>(r => { release = () => r(0); }); }, 10, () => t);
    const first = s.maybeSweep();
    t = 100;
    expect(s.maybeSweep()).toBeUndefined();
    release();
    await first;
    expect(s.maybeSweep()).toBeDefined();
    expect(runs).toBe(2);
  });

  it('a failing sweep (rejected or thrown) resolves, logs a warning, and waits for the next interval', async () => {
    let t = 0;
    let runs = 0;
    const s = new RetentionSweeper(() => {
      runs++;
      if (runs === 1) return Promise.reject(new Error('db down'));
      throw new Error('sync throw');
    }, 1000, () => t);
    await expect(s.maybeSweep()).resolves.toBeUndefined();
    expect(s.maybeSweep()).toBeUndefined();
    t = 1000;
    await expect(s.maybeSweep()).resolves.toBeUndefined();
    expect(runs).toBe(2);
    const warns = lines.map(l => JSON.parse(l)).filter(l => l.event === 'retention_sweep_failed');
    expect(warns.map(w => [w.severity, w.error])).toEqual([['WARNING', 'db down'], ['WARNING', 'sync throw']]);
  });

  it('logs nothing when nothing expired', async () => {
    await new RetentionSweeper(async () => 0).maybeSweep();
    expect(lines).toEqual([]);
  });
});
