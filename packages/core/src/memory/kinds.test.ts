import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByIds } from '../store/index.js';
import { toChroma, fromChroma } from '../metadata-adapter.js';
import { isOpenTyped, normalizeTyped, typedLabel, TypedMemoryError } from './kinds.js';
import { storeMemory } from './store.js';
import { updateMemory } from './update.js';
import { putExternal, findExternal } from './external.js';
import { listMemories } from './list.js';
import { createTask } from '../tasks/create.js';
import { getTask } from '../tasks/update.js';
import { waitingOn } from '../tasks/waiting.js';

let dir: string;
const C = 'project-kinds';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-kinds-test-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester' }));
  setStore(createLocalStore(dir));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('normalizeTyped', () => {
  it('fills the default status for a kind', () => {
    expect(normalizeTyped({ kind: 'finding' }).status).toBe('open');
    expect(normalizeTyped({ kind: 'decision' }).status).toBe('proposed');
    expect(normalizeTyped({ kind: 'question' }).status).toBe('open');
  });

  it('rejects a status that does not belong to the kind', () => {
    expect(() => normalizeTyped({ kind: 'finding', status: 'accepted' })).toThrow(TypedMemoryError);
    expect(() => normalizeTyped({ kind: 'nonsense' as any })).toThrow(/kind must be one of/);
  });

  it('needs a kind for kind-specific fields, and the right kind', () => {
    expect(() => normalizeTyped({ status: 'open' })).toThrow(/need a kind/);
    expect(() => normalizeTyped({ kind: 'question', options: ['a', 'b'] })).toThrow(/applies to a decision/);
    expect(normalizeTyped({ owner: 'alex', task_ids: ['t-1'] })).toEqual({ owner: 'alex', task_ids: ['t-1'] });
  });

  it('a needed decision lists at least two options', () => {
    expect(() => normalizeTyped({ kind: 'decision', status: 'needed', options: ['only one'] })).toThrow(/two options/);
    expect(normalizeTyped({ kind: 'decision', status: 'needed', options: ['a', 'b'], owner: 'alex' }).owner).toBe('alex');
  });

  it('a resolved finding says what became of it', () => {
    expect(() => normalizeTyped({ status: 'resolved' }, { kind: 'finding', status: 'open' })).toThrow(/disposition/);
    expect(() => normalizeTyped({ status: 'resolved', disposition: 'no-action' }, { kind: 'finding' })).toThrow(/reason/);
    expect(() => normalizeTyped({ status: 'resolved', disposition: 'task' }, { kind: 'finding' })).toThrow(/disposition_ids/);
    expect(normalizeTyped({ status: 'resolved', disposition: 'task', disposition_ids: ['t-9'] }, { kind: 'finding' }).status).toBe('resolved');
  });

  it('refuses to change a memory\'s kind', () => {
    expect(() => normalizeTyped({ kind: 'idea' }, { kind: 'finding', status: 'open' })).toThrow(/is a finding/);
  });

  it('labels and open-ness', () => {
    expect(typedLabel({ kind: 'decision', status: 'needed', owner: 'josh' })).toBe('[decision, needed, for josh]');
    expect(typedLabel({ kind: 'finding', status: 'open', owner: 'josh' })).toBe('[finding, open]');
    expect(typedLabel({})).toBe('');
    expect(isOpenTyped({ kind: 'decision', status: 'accepted' })).toBe(false);
    expect(isOpenTyped({ kind: 'question', status: 'open' })).toBe(true);
    expect(isOpenTyped({ status: 'open' })).toBe(false);
  });
});

describe('metadata adapter', () => {
  it('keeps list items that contain commas', () => {
    const raw = toChroma({ options: ['keep it, for now', 'drop it'], tags: ['a', 'b'] });
    expect(raw.tags).toBe('a,b');
    expect(fromChroma(raw)).toEqual({ options: ['keep it, for now', 'drop it'], tags: ['a', 'b'] });
    expect(fromChroma(toChroma({ task_ids: ['t-1'] }))).toEqual({ task_ids: ['t-1'] });
  });
});

describe('typed memories in the store', () => {
  it('stores typed fields and links the tasks both ways', async () => {
    const task = await createTask('measure the cold-start time', {}, C);
    const { ids: [id] } = await storeMemory('Cold start is dominated by the index load, not the model.', {
      collection: C, typed: { kind: 'finding', task_ids: [task] },
    });
    const [doc] = await getDocumentsByIds(C, [id]);
    expect(doc.metadata).toMatchObject({ kind: 'finding', status: 'open', task_ids: [task] });
    expect((await getTask(task))?.metadata.memory_ids).toEqual([id]);
  });

  it('refuses an invalid typed memory before storing anything', async () => {
    await expect(storeMemory('x', { collection: C, typed: { kind: 'decision', status: 'needed', options: ['a'] } })).rejects.toThrow(TypedMemoryError);
  });

  it('updateMemory changes status in place and appends a dated note', async () => {
    const { ids: [id] } = await storeMemory('Should the cache be per user or shared?', {
      collection: C, typed: { kind: 'decision', status: 'needed', owner: 'alex', options: ['per user', 'shared, with a TTL'] },
    });
    await updateMemory(id, { status: 'accepted', note: 'shared, with a TTL' });
    const [doc] = await getDocumentsByIds(C, [id]);
    expect(doc.metadata.status).toBe('accepted');
    expect(doc.metadata.is_synced).toBe(false);
    expect(doc.content).toMatch(/\n\n\d{4}-\d\d-\d\d tester: shared, with a TTL$/);
    expect(doc.metadata.options).toEqual(['per user', 'shared, with a TTL']);
  });

  it('listMemories filters on kind and status, and finds tags past the limit', async () => {
    for (let i = 0; i < 5; i++) await storeMemory(`filler ${i}`, { collection: C });
    await storeMemory('needle', { collection: C, tags: ['rare'] });
    expect((await listMemories({ collection: C, tags: ['rare'], limit: 1 })).map(m => m.content)).toEqual(['needle']);
    const decisions = await listMemories({ collection: C, kind: 'decision' });
    expect(decisions.every(d => d.metadata.kind === 'decision')).toBe(true);
    expect((await listMemories({ collection: C, kind: 'decision', status: 'needed' }))).toHaveLength(0);
  });
});

describe('putExternal', () => {
  it('creates once, then updates the same memory in place', async () => {
    const a = await putExternal(C, 'spec:ADR-1', {
      content: 'Pick a storage engine', typed: { kind: 'decision', status: 'needed', owner: 'alex', options: ['A', 'B'] },
    });
    expect(a.action).toBe('created');
    expect((await putExternal(C, 'spec:ADR-1', {
      content: 'Pick a storage engine', typed: { kind: 'decision', status: 'needed', owner: 'alex', options: ['A', 'B'] },
    })).action).toBe('unchanged');
    const b = await putExternal(C, 'spec:ADR-1', {
      content: 'Pick a storage engine (now with numbers)', typed: { kind: 'decision', status: 'accepted' },
    });
    expect(b).toEqual({ id: a.id, action: 'updated' });
    const doc = await findExternal(C, 'spec:ADR-1');
    expect(doc?.content).toBe('Pick a storage engine (now with numbers)');
    expect(doc?.metadata).toMatchObject({ status: 'accepted', owner: 'alex', external_ref: 'spec:ADR-1' });
  });
});

describe('waitingOn', () => {
  it('lists decisions, questions, person-only steps and blocked tasks, for a user or for anyone', async () => {
    const W = 'project-waiting';
    const { ids: [dec] } = await storeMemory('Ship on Friday or wait for the fix?', {
      collection: W, typed: { kind: 'decision', status: 'needed', owner: 'josh', options: ['Friday', 'after the fix'], recommendation: 'after the fix' },
    });
    await storeMemory('Which region does the customer run in?', { collection: W, typed: { kind: 'question', owner: 'alex' } });
    await storeMemory('Closed question', { collection: W, typed: { kind: 'question', status: 'answered' } });
    const act = await createTask('Push the release tag', { tags: ['needs-human', 'needs:josh'] }, W);
    const anyone = await createTask('Approve the spend', { tags: ['needs-human'] }, W);
    const blocked = await createTask('Wait for the vendor', { status: 'blocked' }, W);
    const waiter = await createTask('Do the release', { }, W);
    const { updateTask } = await import('../tasks/update.js');
    await updateTask(waiter, { waits_on: [dec] } as any);

    const all = await waitingOn({ collection: W });
    expect(all.decisions.map(d => d.id)).toEqual([dec]);
    expect(all.decisions[0]).toMatchObject({ for: ['josh'], options: ['Friday', 'after the fix'], recommendation: 'after the fix', waiting_tasks: [waiter] });
    expect(all.questions.map(q => [q.for, q.ask])).toEqual([[['tester'], 'alex']]);
    expect(all.actions.map(a => a.id).sort()).toEqual([act, anyone].sort());
    expect(all.blocked.map(b => b.id)).toEqual([blocked]);

    const mine = await waitingOn({ collection: W, user: 'josh' });
    expect(mine.decisions).toHaveLength(1);
    expect(mine.questions).toHaveLength(0);
    expect(mine.actions.map(a => a.id).sort()).toEqual([act, anyone].sort());
    expect(mine.blocked).toHaveLength(0);
  });

  it('matches owners to users case-insensitively, and sends one for someone outside YAPA to whoever recorded it', async () => {
    const W = 'project-owners';
    await createTask('Review the plan', { tags: ['needs:josh'] }, W);
    const { ids: [cap] } = await storeMemory('Keep the old endpoint for a month?', {
      collection: W, typed: { kind: 'decision', status: 'needed', owner: 'Josh', options: ['yes', 'no'] },
    });
    const { ids: [mail] } = await storeMemory('Which plan is the customer on?', { collection: W, typed: { kind: 'question', owner: 'josh@example.com' } });
    const { ids: [ext] } = await storeMemory('Can the vendor raise the limit?', { collection: W, typed: { kind: 'question', owner: 'Vendor support' } });

    const all = await waitingOn({ collection: W });
    expect(all.decisions.map(d => [d.id, d.for, d.ask])).toEqual([[cap, ['josh'], undefined]]);
    expect(all.questions.map(q => [q.id, q.for, q.ask]).sort()).toEqual([[ext, ['tester'], 'Vendor support'], [mail, ['josh'], undefined]].sort());

    expect((await waitingOn({ collection: W, user: 'JOSH' })).questions.map(q => q.id)).toEqual([mail]);
    expect((await waitingOn({ collection: W, user: 'tester' })).questions.map(q => q.id)).toEqual([ext]);
    const { formatWaiting } = await import('../tasks/waiting.js');
    expect(formatWaiting(all)).toMatch(new RegExp(`\\*\\*${ext}\\*\\* \\[question, for tester, ask Vendor support, new\\]`));
  });
});
