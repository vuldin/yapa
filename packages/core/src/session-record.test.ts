import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, resetConfig, setConfig } from './config.js';
import { pruneSessionRecords, recordSessionStart, removeSessionRecord, sessionRecordDir, sessionRecordFile } from './session-record.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-sess-'));
  setConfig(createConfig({ YAPA_SYNC_HEALTH_FILE: join(dir, 'sync-health.json') }));
});
afterEach(() => {
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe('session records', () => {
  it('a server records its version for its session, and removes it at exit', () => {
    expect(sessionRecordDir()).toBe(join(dir, 'sessions'));
    const file = recordSessionStart('1.10.1', { session: 'sess-1', now: 5 })!;
    expect(file).toBe(sessionRecordFile('sess-1'));
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ version: '1.10.1', pid: process.pid, started_at: 5 });
    removeSessionRecord({ session: 'sess-1' });
    expect(existsSync(file)).toBe(false);
  });

  it('never removes a record another server wrote since; prunes records of dead servers', () => {
    const file = recordSessionStart('1.10.1', { session: 'sess-2' })!;
    writeFileSync(file, JSON.stringify({ version: '1.10.2', pid: process.ppid, started_at: 9 }));
    removeSessionRecord({ session: 'sess-2' });
    expect(existsSync(file)).toBe(true);
    writeFileSync(join(dir, 'sessions', 'gone.json'), JSON.stringify({ version: '1.10.0', pid: 2 ** 30, started_at: 1 }));
    pruneSessionRecords();
    expect(existsSync(join(dir, 'sessions', 'gone.json'))).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it('does nothing without a session or a health file', () => {
    const saved = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    try {
      expect(recordSessionStart('1.10.1')).toBeUndefined();
      setConfig(createConfig({ YAPA_SYNC_HEALTH_FILE: 'off' }));
      expect(recordSessionStart('1.10.1', { session: 's' })).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CODE_SESSION_ID = saved;
    }
  });
});
