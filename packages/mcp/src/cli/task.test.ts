import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, createConfig, resetConfig, setStore, resetStore, createLocalStore, createTask, getTask } from '@yapa/core';
import { runTask } from './task.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-task-cli-'));
  // No sync service: claims are coordinated on this machine.
  setConfig(createConfig({ YAPA_USERNAME: 'josh', YAPA_SYNC_ENABLED: 'false', YAPA_LOCAL_COORD_DIR: join(dir, 'coord'), YAPA_LEASE_STATE_DIR: join(dir, 'leases') }));
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
    expect(claim).toMatchObject({ exit: 0, json: { ok: true, id: a, session: 's1', claim: { kind: 'granted' } } });
    expect((await getTask(a))?.metadata.status).toBe('in_progress');
    // Another session is refused (exit 3), and nothing changes.
    const second = await runTask('claim', [a, '--session', 's2']);
    expect(second).toMatchObject({ exit: 3, json: { ok: false, refused: true } });
    expect(second.text).toMatch(/is being worked on by you \(another session, s1\)/);
    const n2 = await runTask('next', ['--collection', 'project-cli', '--claim', '--session', 's2']);
    expect((n2.json.claimed as any)?.id).not.toBe(a);
    expect((n2.json.skipped as any[]).find(x => x.id === a).reason).toMatch(/^claimed by you \(another session, s1\)/);
    if ((n2.json.claimed as any)?.id) await runTask('release', [(n2.json.claimed as any).id, '--collection', 'project-cli', '--session', 's2']);

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

describe('yapa task capture at close', () => {
  it('release records a needed decision and the task waits on it; learned and follow-ups are stored with complete', async () => {
    const { writeFileSync } = await import('node:fs');
    const id = await createTask('choose the cache', { tags: ['auto'] }, 'project-cap');
    const dn = join(dir, 'dn.json');
    writeFileSync(dn, JSON.stringify({ question: 'Shared cache or per user?', options: ['shared', 'per user'], owner: 'alex' }));
    const rel = await runTask('release', [id, '--status', 'pending', '--decision-needed-file', dn]);
    expect(rel.exit).toBe(0);
    const decision = rel.json.decision as string;
    expect(decision).toMatch(/^mem-/);
    expect((await getTask(id))?.metadata).toMatchObject({ status: 'pending', waits_on: [decision] });

    const next = await runTask('next', ['--collection', 'project-cap', '--auto-only']);
    expect((next.json.skipped as any[]).find(s => s.id === id).reason).toBe(`waiting on decision ${decision} (needed, for alex)`);

    expect((await runTask('release', [id, '--status', 'blocked', '--decision-needed-file', dn])).exit).toBe(2);

    const learned = join(dir, 'learned.json');
    writeFileSync(learned, JSON.stringify([{ kind: 'finding', content: 'A shared cache halves the cold starts.' }]));
    const fu = join(dir, 'fu.json');
    writeFileSync(fu, JSON.stringify([{ title: 'Measure the cache hit rate', tags: ['auto'] }]));
    const done = await runTask('release', [id, '--status', 'complete', '--learned-file', learned, '--follow-ups-file', fu]);
    expect(done.exit).toBe(0);
    expect((done.json.recorded as any).memories).toHaveLength(1);
    expect((done.json.recorded as any).follow_ups).toHaveLength(1);
    expect(done.json.nudge).toBeNull();

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify([{ kind: 'finding', status: 'resolved', content: 'x' }]));
    const other = await createTask('another', {}, 'project-cap');
    expect((await runTask('release', [other, '--status', 'complete', '--learned-file', bad])).exit).toBe(2);
    expect((await getTask(other))?.metadata.status).toBe('pending');
  });

  it('claims and releases a cleanup key as a lease only', async () => {
    const c = await runTask('claim', ['cleanup:triage', '--collection', 'project-cap']);
    expect(c).toMatchObject({ exit: 0, json: { ok: true, id: 'cleanup:triage', claim: { kind: 'granted' } } });
    expect((await runTask('claim', ['cleanup:triage', '--collection', 'project-cap', '--session', 'other'])).exit).toBe(3);
    expect((await runTask('claim', ['cleanup:triage'])).exit).toBe(2);
    expect((await runTask('release', ['cleanup:triage', '--collection', 'project-cap'])).exit).toBe(0);
  });
});
