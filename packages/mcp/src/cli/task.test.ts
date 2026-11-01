import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, createConfig, resetConfig, setStore, resetStore, createLocalStore, createTask, getTask } from '@yapa/core';
import { runTask } from './task.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-task-cli-'));
  // No sync service: claims are local (nothing to coordinate), exit 0.
  setConfig(createConfig({ YAPA_USERNAME: 'josh', YAPA_SYNC_ENABLED: 'false' }));
  setStore(createLocalStore(join(dir, 'store')));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('yapa task', () => {
  it('next, claim and release round-trip with JSON and exit codes', async () => {
    const a = await createTask('first', { priority: 'high' }, 'project-cli');
    const b = await createTask('second', { tags: ['needs-human'] }, 'project-cli');

    const next = await runTask('next', ['--collection', 'project-cli', '--exclude-tag', 'needs-human']);
    expect(next.exit).toBe(0);
    expect((next.json.ready as any[]).map(t => t.id)).toEqual([a]);
    expect(next.json.skipped).toEqual([{ id: b, reason: 'tagged needs-human' }]);

    const claim = await runTask('claim', [a, '--session', 's1']);
    expect(claim).toMatchObject({ exit: 0, json: { ok: true, id: a, session: 's1', claim: { kind: 'local' } } });
    expect((await getTask(a))?.metadata.status).toBe('in_progress');

    const rel = await runTask('release', [a, '--status', 'pending', '--note', 'handing back', '--tag', 'spec:X', '--session', 's1']);
    expect(rel.exit).toBe(0);
    const t = await getTask(a);
    expect(t?.metadata.status).toBe('pending');
    expect(t?.metadata.notes).toBe('handing back');
    expect(t?.metadata.tags).toContain('spec:X');

    const done = await runTask('release', [a, '--status', 'complete', '--duration', '30']);
    expect(done.exit).toBe(0);
    expect((await getTask(a))?.metadata).toMatchObject({ status: 'complete', duration_minutes: 30 });

    const list = await runTask('list', ['--collection', 'project-cli', '--include-complete']);
    expect((list.json.tasks as any[]).map(x => x.id).sort()).toEqual([a, b].sort());
  });

  it('bad arguments exit 2', async () => {
    expect((await runTask('release', ['josh-1'])).exit).toBe(2);
    expect((await runTask('next', [])).exit).toBe(2);
    expect((await runTask('bogus', [])).exit).toBe(2);
  });
});
