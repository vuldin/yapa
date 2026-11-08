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

  it('list hides upcoming recurring occurrences unless --include-upcoming; release complete reports the next one', async () => {
    const C = 'project-cli-recurring';
    const soon = await createTask('send the weekly digest', { recurrence_pattern: 'weekly' }, C);
    const later = await createTask('renew the certificate', { recurrence_pattern: 'yearly', due_date: Math.floor(Date.now() / 1000) + 200 * 86400 }, C);
    const open = await runTask('list', ['--collection', C]);
    expect((open.json.tasks as any[]).map(t => t.id)).toEqual([soon]);
    expect(open.json.upcoming_hidden).toBe(1);
    expect((await runTask('list', ['--collection', C, '--tag', 'nothing-has-this'])).json.upcoming_hidden).toBe(0);
    const all = (await runTask('list', ['--collection', C, '--include-upcoming'])).json.tasks as any[];
    expect(all.map(t => t.id).sort()).toEqual([soon, later].sort());
    expect(all.find(t => t.id === later).recurrence).toMatchObject({ pattern: 'yearly', interval: 1, lead_days: 30, series: later, previous: null, upcoming: true });
    expect(all.find(t => t.id === soon).recurrence.upcoming).toBe(false);

    const done = await runTask('release', [soon, '--status', 'complete']);
    const next = (done.json.regenerated as any);
    expect(next).toMatchObject({ id: expect.stringMatching(/^josh-\d+$/) });
    expect(next.due_date - (await getTask(soon))!.metadata.due_date).toBeGreaterThanOrEqual(7 * 86400 - 3600);
    expect(done.text.split('\n')[0]).toBe(`${soon} -> complete`);
    expect(done.text.split('\n')[1]).toMatch(new RegExp(`^regenerated as ${next.id} \\(recurring\\), due .*, opens `));
    expect((all.find(t => t.id === soon).recurrence)).toMatchObject({ series: soon, next: null });
    const after = ((await runTask('show', [soon])).json.task as any).recurrence;
    expect(after).toMatchObject({ series: soon, next: next.id });
    expect(done.json.existing_next).toBeNull();
    await runTask('release', [soon, '--status', 'pending']);
    const again = await runTask('release', [soon, '--status', 'complete']);
    expect(again.json).toMatchObject({ regenerated: null, existing_next: next.id });
    expect(again.text.split('\n')[1]).toBe(`next occurrence ${next.id} (already created)`);
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

describe('yapa task release from a folder outside every project root', () => {
  it('refuses a follow-up in a new shared collection (exit 3) before the task changes', async () => {
    const { writeFileSync } = await import('node:fs');
    const { listCollections } = await import('@yapa/core');
    const scope = join(dir, 'scope.json');
    writeFileSync(scope, JSON.stringify({ project_roots: [join(dir, 'projects')] }));
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = join(dir, 'home');
    setConfig(createConfig({ YAPA_USERNAME: 'josh', YAPA_SYNC_ENABLED: 'false', YAPA_LOCAL_COORD_DIR: join(dir, 'coord'), YAPA_LEASE_STATE_DIR: join(dir, 'leases'), YAPA_SCOPE_FILE: scope }));
    try {
      const id = await createTask('close me', {}, 'project-cli');
      const f = join(dir, 'follow-ups.json');
      writeFileSync(f, JSON.stringify([{ title: 'next', collection: 'project-brandnew' }]));
      const r = await runTask('release', [id, '--status', 'complete', '--follow-ups-file', f]);
      expect(r).toMatchObject({ exit: 3, json: { ok: false, refused: true, code: 'shared_collection_not_allowed' } });
      expect((await getTask(id))?.metadata.status).not.toBe('done');
      expect((await listCollections()).map(c => c.name)).not.toContain('project-brandnew');
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
      setConfig(createConfig({ YAPA_USERNAME: 'josh', YAPA_SYNC_ENABLED: 'false', YAPA_LOCAL_COORD_DIR: join(dir, 'coord'), YAPA_LEASE_STATE_DIR: join(dir, 'leases') }));
    }
  });
});
