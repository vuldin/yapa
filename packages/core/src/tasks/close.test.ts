import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByIds } from '../store/index.js';
import { createTask } from './create.js';
import { completeTask, getTask, updateTask } from './update.js';
import { requestDecision, openWaits } from './close.js';
import { nextTasks } from './next.js';
import { updateMemory } from '../memory/update.js';
import { storeMemory } from '../memory/store.js';
import { waitingOn } from './waiting.js';
import { TypedMemoryError } from '../memory/kinds.js';

let dir: string;
const C = 'project-close';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-close-test-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true', YAPA_COMPACTION_THRESHOLD: '100000' }));
  setStore(createLocalStore(dir));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('completeTask with what was learned', () => {
  it('stores linked typed memories and follow-up tasks in one call', async () => {
    const id = await createTask('profile the importer', {}, C);
    const r = await completeTask(id, 30, {}, {
      learned: [
        { kind: 'finding', content: 'The importer spends most of its time in JSON parsing.' },
        { kind: 'idea', content: 'Stream the parse instead of loading the whole file.' },
      ],
      follow_ups: [{ title: 'Try a streaming parser in the importer', priority: 'high', tags: ['auto'] }],
    });
    expect(r.nudge).toBeUndefined();
    expect(r.recorded?.memories).toHaveLength(2);
    const task = await getTask(id);
    expect(task?.metadata.status).toBe('complete');
    expect(task?.metadata.memory_ids).toEqual(r.recorded?.memories);
    const [m] = await getDocumentsByIds(C, [r.recorded!.memories[0]]);
    expect(m.metadata).toMatchObject({ kind: 'finding', status: 'open', task_ids: [id] });
    const follow = await getTask(r.recorded!.follow_ups[0]);
    expect(follow?.metadata.notes).toBe(`From ${id}.`);
    expect(follow?.metadata.priority).toBe('high');
  });

  it('nudges when nothing was recorded, and not when a memory already names the task', async () => {
    const a = await createTask('quiet task', {}, C);
    expect((await completeTask(a)).nudge).toMatch(/^Nothing was recorded for/);
    const b = await createTask('task with a finding', {}, C);
    await storeMemory('b found something', { collection: C, typed: { kind: 'finding', task_ids: [b] } });
    expect((await completeTask(b)).nudge).toBeUndefined();
  });

  it('refuses an invalid learned item before completing anything', async () => {
    const id = await createTask('still open', {}, C);
    await expect(completeTask(id, undefined, {}, { learned: [{ kind: 'decision', status: 'needed', content: 'x', options: ['one'] }] }))
      .rejects.toThrow(TypedMemoryError);
    expect((await getTask(id))?.metadata.status).toBe('pending');
  });
});

describe('a decision only a person can make', () => {
  it('waits the task on the decision until it is recorded, then the task is ready again', async () => {
    const D = 'project-decide';
    const id = await createTask('migrate the queue', { tags: ['auto'] }, D);
    const other = await createTask('something else', { tags: ['auto'] }, D);
    const r = await requestDecision(id, {
      question: 'Migrate with downtime, or run both queues for a week?',
      options: ['a short downtime', 'both queues for a week'], recommendation: 'a short downtime', owner: 'alex',
    });
    const task = await getTask(id);
    expect(task?.metadata).toMatchObject({ status: 'pending', waits_on: [r.decision] });

    let next = await nextTasks({ collection: D });
    expect(next.ready.map(t => t.id)).toEqual([other]);
    expect(next.skipped.find(s => s.id === id)?.reason).toBe(`waiting on decision ${r.decision} (needed, for alex)`);

    const w = await waitingOn({ collection: D, user: 'alex' });
    expect(w.decisions[0]).toMatchObject({ id: r.decision, waiting_tasks: [id], recommendation: 'a short downtime' });

    await updateMemory(r.decision, { status: 'accepted', note: 'a short downtime, Saturday 06:00' });
    expect(await openWaits((await getTask(id))!.metadata)).toEqual([]);
    next = await nextTasks({ collection: D });
    expect(next.ready.map(t => t.id).sort()).toEqual([id, other].sort());
  });

  it('follows a superseded decision to its replacement', async () => {
    const { ids: [old] } = await storeMemory('Pick a region', { collection: C, typed: { kind: 'decision', status: 'needed', options: ['east', 'west'] } });
    const id = await createTask('deploy', {}, C);
    await updateTask(id, { waits_on: [old] });
    const { ids: [replacement] } = await storeMemory('Pick a region (with the latency numbers)', {
      collection: C, supersedes: old, typed: { kind: 'decision', status: 'needed', options: ['east', 'west'] },
    });
    expect((await openWaits((await getTask(id))!.metadata)).map(w => w.id)).toEqual([replacement]);
  });
});

describe('triage and cleanup in the ready queue', () => {
  it('skips steps that need a person, honors autoOnly, and offers cleanup when nothing is ready', async () => {
    const T = 'project-triage';
    const human = await createTask('approve the budget', { tags: ['needs-human', 'needs:josh'] }, T);
    const untagged = await createTask('tidy the docs', {}, T);
    let next = await nextTasks({ collection: T, autoOnly: true });
    expect(next.ready).toEqual([]);
    expect(next.skipped).toEqual(expect.arrayContaining([
      { id: human, reason: 'needs a person (josh)' },
      { id: untagged, reason: 'not tagged auto' },
    ]));
    expect(next.cleanup.map(c => c.key)).toEqual(['cleanup:triage']);
    expect(next.cleanup[0].count).toBe(1);

    next = await nextTasks({ collection: T, autoOnly: true, claim: true });
    expect(next.claimed).toEqual({ kind: 'local', id: 'cleanup:triage' });

    next = await nextTasks({ collection: T });
    expect(next.ready.map(t => t.id)).toEqual([untagged]);
    expect(next.cleanup).toEqual([]);
  });

  it('clears a blocked reason when the task leaves blocked, and syncs a reason-only change', async () => {
    const id = await createTask('blocked one', {}, C);
    await updateTask(id, { status: 'blocked', blockedReason: 'vendor' });
    await updateTask(id, { is_synced: true } as any);
    await updateTask(id, { blockedReason: 'vendor, again' });
    expect((await getTask(id))?.metadata.is_synced).toBe(false);
    await updateTask(id, { status: 'pending' });
    expect((await getTask(id))?.metadata.blockedReason).toBe('');
  });
});
