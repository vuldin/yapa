import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConfig, resetConfig, setConfig } from './config.js';
import { lastWriteDir, lastWriteFile, pruneLastWrites, readLastWrite, recordLastWrite } from './last-write.js';

let dir: string;
const saved = { claude: process.env.CLAUDE_CODE_SESSION_ID, yapa: process.env.YAPA_SESSION };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-lw-'));
  setConfig(createConfig({ YAPA_SYNC_HEALTH_FILE: join(dir, 'sync-health.json') }));
  delete process.env.YAPA_SESSION;
  process.env.CLAUDE_CODE_SESSION_ID = 'sess-1';
});

afterEach(() => {
  resetConfig();
  for (const [k, v] of [['CLAUDE_CODE_SESSION_ID', saved.claude], ['YAPA_SESSION', saved.yapa]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('last write', () => {
  it('lives in last-write/ beside the health file, one file per Claude Code session', () => {
    expect(lastWriteDir()).toBe(join(dir, 'last-write'));
    recordLastWrite('project-acme', { now: 1000 });
    recordLastWrite('customer-globex', { now: 2000 });
    expect(readLastWrite('sess-1')).toEqual({ collection: 'customer-globex', at: 2000 });
    expect(readdirSync(join(dir, 'last-write'))).toEqual(['sess-1.json']);
  });

  it('keys by the Claude Code session ahead of YAPA_SESSION (a claim holder name)', () => {
    process.env.YAPA_SESSION = 'queue-worker-3';
    recordLastWrite('project-acme', { now: 1000 });
    expect(readLastWrite('sess-1')?.collection).toBe('project-acme');
    delete process.env.CLAUDE_CODE_SESSION_ID;
    recordLastWrite('project-other', { now: 2000 });
    expect(readLastWrite('queue-worker-3')?.collection).toBe('project-other');
  });

  it('does nothing without a session, a collection, or a health file', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    recordLastWrite('project-acme');
    recordLastWrite(undefined, { session: 'sess-2' });
    setConfig(createConfig({ YAPA_SYNC_HEALTH_FILE: 'off' }));
    recordLastWrite('project-acme', { session: 'sess-3' });
    expect(readdirSync(dir)).toEqual([]);
    expect(readLastWrite('sess-3')).toBeUndefined();
  });

  it('names files the way the status line looks them up', () => {
    expect(lastWriteFile('a:b/c', '/x')).toBe(join('/x', 'a_b_c.json'));
  });

  it('prunes records untouched for a week', () => {
    const lw = join(dir, 'last-write');
    recordLastWrite('project-acme', { session: 'old' });
    recordLastWrite('project-acme', { session: 'new' });
    const week = 7 * 24 * 3600;
    utimesSync(join(lw, 'old.json'), Date.now() / 1000 - week - 60, Date.now() / 1000 - week - 60);
    writeFileSync(join(lw, 'stray.tmp'), '');
    pruneLastWrites(lw);
    expect(readdirSync(lw).sort()).toEqual(['new.json', 'stray.tmp']);
  });
});
