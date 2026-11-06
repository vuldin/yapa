import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import {
  applyCaptureEvent, captureDownLine, captureFailing, dayKey, readCaptureHealth, recordCapture, summarizeCapture, type CaptureHealth,
} from './health.js';

const dir = mkdtempSync(join(tmpdir(), 'yapa-capture-health-'));
const NOW = new Date(2026, 10, 6, 15, 0, 0).getTime();
const H = 3_600_000;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('capture health records', () => {
  it('counts turns, failures and compactions per day, and keeps the last error and success', () => {
    let h: CaptureHealth | undefined;
    h = applyCaptureEvent(h, { kind: 'turn', stored: 2, skipped: 1, settled: 1 }, NOW - 3 * H);
    h = applyCaptureEvent(h, { kind: 'turn', stored: 0, skipped: 0, settled: 0, followThroughError: new Error('judge timed out') }, NOW - 2 * H);
    h = applyCaptureEvent(h, { kind: 'turn_failed', error: new Error('claude -p exited 1:\n  model not found') }, NOW - H);
    h = applyCaptureEvent(h, { kind: 'compaction' }, NOW - H / 2);
    expect(h.days[dayKey(NOW)]).toEqual({ turns: 2, clean: 1, stored: 2, skipped: 1, settled: 1, judged: 0, failed: 1, follow_through_failed: 1, store_failed: 0, compactions: 1, compactions_failed: 0 });
    expect(h.last_error).toEqual({ at: NOW - H, stage: 'extractor', message: 'claude -p exited 1: model not found' });
    expect(h.last_ok_at).toBe(NOW - H / 2);
  });

  it('keeps two weeks of days', () => {
    let h: CaptureHealth | undefined;
    for (let i = 20; i >= 0; i--) h = applyCaptureEvent(h, { kind: 'turn', stored: 1, skipped: 0, settled: 0 }, NOW - i * 24 * H);
    expect(Object.keys(h!.days)).toHaveLength(14);
    expect(summarizeCapture(h, NOW, 7)).toMatchObject({ days: 7, turns: 7, stored: 7, failing: false });
  });

  it('counts one failed turn once, and a follow-through failure alone does not light it within the hour', () => {
    let h = applyCaptureEvent(undefined, { kind: 'turn_failed', error: 'bad model' }, NOW - 2 * H);
    expect(captureFailing(h, NOW)).toBe(false);
    h = applyCaptureEvent(undefined, { kind: 'turn', stored: 1, skipped: 0, settled: 0, followThroughError: 'judge timed out' }, NOW - 60_000);
    expect(captureFailing(h, NOW)).toBe(false);
    expect(captureDownLine(h, NOW)).toContain('So open decisions, questions and findings may not have been updated');
    h = applyCaptureEvent(h, { kind: 'turn', stored: 0, skipped: 0, settled: 0, storeError: new Error('collection is read-only') }, NOW - 30_000);
    expect(captureFailing(h, NOW)).toBe(true);
    expect(h.days[dayKey(NOW)]).toMatchObject({ turns: 2, clean: 0, store_failed: 1, follow_through_failed: 1 });
    expect(captureDownLine(h, NOW)).toContain('(store, 2 failed run(s) today)');
  });

  it('keeps the model\'s reply and tokens out of the stored message', () => {
    const h1 = applyCaptureEvent(undefined, { kind: 'turn_failed', error: new Error('Extractor response was not a JSON array: the password is hunter2') }, NOW);
    expect(h1.last_error?.message).toBe('Extractor response was not a JSON array');
    const h2 = applyCaptureEvent(undefined, { kind: 'turn_failed', error: new Error('Could not extract JSON array from extractor response: {"secret": 1}') }, NOW);
    expect(h2.last_error?.message).toBe('Could not extract JSON array from extractor response');
    const h3 = applyCaptureEvent(undefined, { kind: 'turn_failed', error: new Error('401 for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl') }, NOW);
    expect(h3.last_error?.message).toBe('401 for <token>');
  });

  it('steps calendar days, so a short DST day is never skipped', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Chicago';
    try {
      const at = new Date(2026, 2, 9, 0, 30).getTime();
      let h: CaptureHealth | undefined;
      for (const day of [7, 8, 9]) h = applyCaptureEvent(h, { kind: 'turn', stored: 1, skipped: 0, settled: 0 }, new Date(2026, 2, day, 0, 10).getTime());
      expect(summarizeCapture(h, at, 3).turns).toBe(3);
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  it('is failing when the latest run failed within the hour, or failures outnumber successes today', () => {
    let h = applyCaptureEvent(undefined, { kind: 'turn', stored: 1, skipped: 0, settled: 0 }, NOW - 2 * H);
    expect(captureFailing(h, NOW)).toBe(false);
    h = applyCaptureEvent(h, { kind: 'turn_failed', error: 'bad model' }, NOW - 10 * 60_000);
    expect(captureFailing(h, NOW)).toBe(true);
    expect(captureFailing(h, NOW + 2 * H)).toBe(false);
    h = applyCaptureEvent(h, { kind: 'turn_failed', error: 'bad model' }, NOW - 9 * 60_000);
    expect(captureFailing(h, NOW + 2 * H)).toBe(true);
    h = applyCaptureEvent(h, { kind: 'turn', stored: 0, skipped: 0, settled: 0 }, NOW - 5 * 60_000);
    expect(captureFailing(h, NOW)).toBe(false);
  });

  it('says so at session start for a day after a failure, until a run succeeds', () => {
    let h = applyCaptureEvent(undefined, { kind: 'turn_failed', error: 'claude -p: command not found' }, NOW - 3 * H);
    expect(captureDownLine(h, NOW)).toBe('**YAPA capture is failing** (extractor, 1 failed run(s) today): claude -p: command not found. So memories from recent turns may be missing; `yapa capture status` for details.');
    expect(captureDownLine(h, NOW + 30 * H)).toBeUndefined();
    h = applyCaptureEvent(h, { kind: 'turn', stored: 0, skipped: 0, settled: 0 }, NOW - H);
    expect(captureDownLine(h, NOW)).toBeUndefined();
    expect(captureDownLine(undefined, NOW)).toBeUndefined();
  });

  it('writes the file, and never throws when it cannot', () => {
    const file = join(dir, 'h1', 'capture-health.json');
    recordCapture({ kind: 'turn', stored: 1, skipped: 0, settled: 0 }, NOW, file);
    recordCapture({ kind: 'compaction', error: new Error('store down') }, NOW + 1, file);
    expect(readCaptureHealth(file)?.days[dayKey(NOW)]).toMatchObject({ turns: 1, compactions: 1, compactions_failed: 1 });
    writeFileSync(join(dir, 'blocker'), 'x');
    expect(() => recordCapture({ kind: 'turn', stored: 1, skipped: 0, settled: 0 }, NOW, join(dir, 'blocker', 'capture-health.json'))).not.toThrow();
    expect(() => recordCapture({ kind: 'turn', stored: 1, skipped: 0, settled: 0 }, NOW, '')).not.toThrow();
  });
});

describe('capture health from many processes', () => {
  const bundle = join(dir, 'health.mjs');
  const worker = join(dir, 'worker.mjs');
  beforeAll(async () => {
    await build({ entryPoints: [join(__dirname, 'health.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    writeFileSync(worker, `
      const { recordCapture } = await import(${JSON.stringify(bundle)});
      const [file, startAt] = process.argv.slice(2);
      while (Date.now() < Number(startAt)) await new Promise(r => setTimeout(r, 1));
      for (let i = 0; i < 20; i++) recordCapture({ kind: 'turn', stored: 1, skipped: 0, settled: 0 }, Date.now(), file);
    `);
  });

  it('loses no event when 6 processes record at once', async () => {
    const file = join(dir, 'multi', 'capture-health.json');
    const startAt = Date.now() + 400;
    await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [worker, file, String(startAt)], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr!.on('data', d => { err += d; });
      p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${err}`))));
    })));
    const h = JSON.parse(readFileSync(file, 'utf-8')) as CaptureHealth;
    expect(Object.values(h.days).reduce((n, d) => n + d.turns, 0)).toBe(120);
  }, 30_000);
});
