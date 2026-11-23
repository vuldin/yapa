import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from './config.js';
import { jobDue, jobFiles, readJobRecord, recordJob, tryAcquireJob } from './jobs.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-jobs-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_HEALTH_FILE: join(dir, 'sync-health.json') }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
});

describe('jobs', () => {
  it('is due until a run is recorded within the interval', () => {
    expect(jobDue('j', 1000, 10_000)).toBe(true);
    recordJob('j', { startedAt: 9_000, finishedAt: 9_500, result: { n: 1 } });
    expect(jobDue('j', 1000, 10_000)).toBe(false);
    expect(jobDue('j', 1000, 10_600)).toBe(true);
    expect(readJobRecord<{ n: number }>('j')).toMatchObject({ runs: 1, result: { n: 1 } });
    recordJob('j', { startedAt: 11_000, finishedAt: 11_000 });
    expect(readJobRecord('j')?.runs).toBe(2);
  });

  it('locks against a live holder and takes over a dead or stale one', () => {
    const f = jobFiles('j')!;
    mkdirSync(dir, { recursive: true });
    const release = tryAcquireJob('j', 60_000);
    expect(release).toBeDefined();
    expect(tryAcquireJob('j', 60_000)).toBeUndefined();
    release!();
    expect(existsSync(f.lock)).toBe(false);
    writeFileSync(f.lock, JSON.stringify({ pid: 999_999_999, started_at: Date.now() }));
    expect(tryAcquireJob('j', 60_000, { alive: () => false })).toBeDefined();
    rmSync(f.lock, { force: true });
    writeFileSync(f.lock, JSON.stringify({ pid: process.pid, started_at: Date.now() - 120_000 }));
    expect(tryAcquireJob('j', 60_000)).toBeDefined();
  });

  it('has no files and never blocks without a health file', () => {
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_HEALTH_FILE: 'off' }));
    expect(jobFiles('j')).toBeUndefined();
    expect(jobDue('j', 1000)).toBe(true);
    expect(tryAcquireJob('j', 1000)).toBeDefined();
  });
});
