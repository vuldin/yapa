import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, createConfig, resetConfig, recordCapture } from '@yapa/core';
import { runCapture } from './capture.js';

const dir = mkdtempSync(join(tmpdir(), 'yapa-capture-cli-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
});

describe('yapa capture status', () => {
  it('summarizes the counts and the last error', () => {
    setConfig(createConfig({ YAPA_USERNAME: 'josh', YAPA_SYNC_HEALTH_FILE: join(dir, 'sync-health.json') }));
    const now = Date.now();
    const file = join(dir, 'capture-health.json');
    recordCapture({ kind: 'turn', stored: 2, skipped: 1, settled: 1 }, now - 3_600_000 * 2, file);
    recordCapture({ kind: 'turn_failed', error: new Error('claude -p: command not found') }, now - 600_000, file);
    const r = runCapture('status', [], now);
    expect(r.exit).toBe(0);
    expect(r.text).toContain('1 turn(s) judged, 2 stored, 1 skipped as known, 1 settled');
    expect(r.text).toContain('Failures: 1 extraction, 0 follow-through, 0 of 0 compaction capture(s)');
    expect(r.text).toContain('Last error (extractor, 10 min ago): claude -p: command not found');
    expect(r.text).toContain('Status: FAILING');
    expect(r.json).toMatchObject({ ok: true, file, turns: 1, failed: 1, failing: true });
  });

  it('refuses unknown subcommands and bad --days', () => {
    expect(runCapture(undefined, []).exit).toBe(2);
    expect(runCapture('status', ['--days', '0']).exit).toBe(2);
    expect(runCapture('status', ['--days', 'x']).exit).toBe(2);
  });
});
