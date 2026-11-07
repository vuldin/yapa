import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByIds, getDocumentsByFilter, addDocument, getOrCreateCollection } from '../store/index.js';
import { editScopeSettings, readScopeSettings, formatScopeSettings, ScopeFileError } from '../scope-file.js';
import { runScopeAction } from '../scope.js';
import { storeMemory } from './store.js';
import { updateMemory } from './update.js';
import { putExternal } from './external.js';
import { untypeCollection, RecordsElsewhereError } from './records-elsewhere.js';
import { mergeCollections } from '../collections/manage.js';
import { createTask } from '../tasks/create.js';
import { recordForTask, requestDecision, keptAsNotesLine } from '../tasks/close.js';
import { waitingOn } from '../tasks/waiting.js';
import { captureTurn } from '../curation/capture.js';
import { followThrough } from '../curation/follow-through.js';

let dir: string;
const C = 'private-acme';
const OPEN = 'private-other';

const meta = async (id: string, c = C) => (await getDocumentsByIds(c, [id]))[0]?.metadata;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-elsewhere-test-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SCOPE_FILE: join(dir, 'scope.json') }));
  setStore(createLocalStore(join(dir, 'store')));
  await editScopeSettings({ op: 'add_records_elsewhere', collection: C });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('the scope file', () => {
  it('lists, adds and removes records_elsewhere collections', async () => {
    expect(readScopeSettings().records_elsewhere).toEqual([C]);
    const again = await editScopeSettings({ op: 'add_records_elsewhere', collection: ` ${C} ` });
    expect(again.changed).toBe(false);
    await expect(editScopeSettings({ op: 'add_records_elsewhere', collection: 'a b' })).rejects.toThrow(ScopeFileError);
    const r = await runScopeAction({ action: 'add_records_elsewhere', collection: 'private-tmp' }, dir);
    expect(r.text).toMatch(/private-tmp now keeps its records elsewhere/);
    expect(r.text).toMatch(/yapa memory untype --collection private-tmp/);
    expect(formatScopeSettings(readScopeSettings())).toMatch(/records_elsewhere: private-acme, private-tmp/);
    const off = await runScopeAction({ action: 'remove_records_elsewhere', collection: 'private-tmp' }, dir);
    expect(off.text).toMatch(/no longer keeps its records elsewhere/);
    expect(readScopeSettings().records_elsewhere).toEqual([C]);
    await expect(runScopeAction({ action: 'add_records_elsewhere' }, dir)).rejects.toThrow(/needs a collection/);
  });
});

describe('storing in a records-elsewhere collection', () => {
  it('keeps a typed memory without an external ref as a note, with its task links', async () => {
    const r = await storeMemory('the acme gateway drops idle connections after 60s', {
      collection: C, typed: { kind: 'finding', owner: 'tester', task_ids: ['tester-1'] },
    });
    expect(r.kept_as_note).toBe(true);
    const m = await meta(r.ids[0]);
    expect(m.kind).toBeUndefined();
    expect(m.status).toBeUndefined();
    expect(m.owner).toBeUndefined();
    expect(m.task_ids).toEqual(['tester-1']);
  });

  it('leaves other collections typed', async () => {
    const r = await storeMemory('the other gateway drops idle connections after 30s', { collection: OPEN, typed: { kind: 'finding' } });
    expect(r.kept_as_note).toBeUndefined();
    expect((await meta(r.ids[0], OPEN)).kind).toBe('finding');
  });

  it('keeps a published memory typed, and waiting lists only it', async () => {
    const before = await waitingOn({ collection: C, user: 'tester' });
    expect(before.questions).toEqual([]);
    await storeMemory('Which region does acme run in?', { collection: C, typed: { kind: 'question', owner: 'tester' } });
    const p = await putExternal(C, 'rec:Q-1', { content: 'Q-1: Which region does acme run in?', typed: { kind: 'question', owner: 'tester' } });
    expect(p.action).toBe('created');
    expect((await meta(p.id)).kind).toBe('question');
    const w = await waitingOn({ collection: C, user: 'tester' });
    expect(w.questions.map(q => q.id)).toEqual([p.id]);
  });

  it('records an answer on a published memory, and refuses giving a note a kind', async () => {
    const p = await putExternal(C, 'rec:Q-2', { content: 'Q-2: Who owns the acme rollout?', typed: { kind: 'question', owner: 'tester' } });
    const u = await updateMemory(p.id, { status: 'answered', note: 'Sam owns it' }, C);
    expect(u.metadata.status).toBe('answered');
    const note = await storeMemory('the acme rollout starts in March', { collection: C });
    await expect(updateMemory(note.ids[0], { kind: 'decision' }, C)).rejects.toThrow(RecordsElsewhereError);
    expect((await meta(note.ids[0])).kind).toBeUndefined();
    const elsewhere = await storeMemory('the other rollout starts in April', { collection: OPEN });
    expect((await updateMemory(elsewhere.ids[0], { kind: 'decision' }, OPEN)).metadata.kind).toBe('decision');
  });

  it('follow-through still settles a published question', async () => {
    const p = await putExternal(C, 'rec:Q-3', { content: 'Q-3: Which acme cluster takes the canary?', typed: { kind: 'question', owner: 'tester' } });
    const call = vi.fn(async () => JSON.stringify([{ id: p.id, status: 'answered', note: 'the staging cluster', evidence: 'use the staging cluster for the canary' }]));
    const r = await followThrough(
      { collection: C, userText: 'use the staging cluster for the canary', assistantText: 'OK.', user: 'tester' },
      { call: call as any, knownUsers: async () => ['tester'] },
    );
    expect(r.changes.map(c => c.id)).toContain(p.id);
    expect((await meta(p.id)).status).toBe('answered');
  });

  it('capture stores its findings as notes', async () => {
    const stored = vi.fn(storeMemory);
    const r = await captureTurn(
      { collection: C, sessionId: 's1', turn: 2, userText: 'what port?', assistantText: 'It moved to 9000.' },
      { maxMemories: 3, maxSalience: 2, dedupeDistance: 0.25 },
      {
        followThrough: vi.fn(async () => ({ judged: 0, changes: [] })) as any,
        extractMemories: vi.fn(async () => [{ content: 'acme API listens on port 9000', tags: ['ports'], salience: 2, sector: 'semantic', rationale: 'config', kind: 'finding' }]) as any,
        queryDocuments: vi.fn(async () => []) as any,
        storeMemory: stored,
        log: vi.fn(), record: vi.fn(), writable: vi.fn(async () => ({})),
      },
    );
    expect(r.stored).toBe(1);
    const m = await meta(r.written![0].id);
    expect(m.source).toBe('auto-capture');
    expect(m.kind).toBeUndefined();
  });

  it('task close stores learned items as notes and says so; decision_needed is refused', async () => {
    const t = await createTask('ship the acme gateway', {}, C);
    const rec = await recordForTask({ id: t, collection: C }, {
      learned: [{ content: 'the acme gateway needs TLS 1.3', kind: 'limitation' }, { content: 'plain note from the task' }],
    });
    expect(rec.memories).toHaveLength(2);
    expect(rec.kept_as_notes).toEqual([rec.memories[0]]);
    expect(keptAsNotesLine(rec)).toMatch(/^Kept .* as a note, without a kind: this collection keeps its records/);
    expect((await meta(rec.memories[0])).task_ids).toEqual([t]);
    await expect(requestDecision(t, { question: 'Ship Friday?', options: ['yes', 'no'] })).rejects.toThrow(/set the task to blocked/);
    expect((await getDocumentsByFilter(C, { type: 'memory', kind: 'decision' }, 10))).toEqual([]);
  });
});

describe('a marked collection merged into another', () => {
  it('carries the mark: writes landing in the target are checked, and untype follows the old name', async () => {
    const OLD = 'private-before', NEW = 'private-after';
    await storeMemory('a typed copy made before the mark', { collection: OLD, typed: { kind: 'finding' } });
    await editScopeSettings({ op: 'add_records_elsewhere', collection: OLD });
    await getOrCreateCollection(NEW);
    await mergeCollections(OLD, NEW);
    const viaOld = await storeMemory('stored under the old name', { collection: OLD, typed: { kind: 'finding' } });
    expect(viaOld.kept_as_note).toBe(true);
    expect((await storeMemory('stored under the new name', { collection: NEW, typed: { kind: 'idea' } })).kept_as_note).toBe(true);
    const dry = await untypeCollection(OLD, { dryRun: true });
    expect(dry.collection).toBe(NEW);
    expect(dry.by_kind).toEqual({ finding: 1 });
    const r = await runScopeAction({ action: 'add_records_elsewhere', collection: OLD }, dir);
    expect(r.text).toMatch(/^private-before was merged into private-after on this machine, so private-after is the one marked/);
    expect(readScopeSettings().records_elsewhere).toContain(NEW);
    const off = await runScopeAction({ action: 'remove_records_elsewhere', collection: NEW }, dir);
    expect(off.text).toMatch(/^private-after no longer keeps its records elsewhere/);
    expect(readScopeSettings().records_elsewhere).not.toContain(OLD);
    expect(readScopeSettings().records_elsewhere).not.toContain(NEW);
    expect((await storeMemory('typed again', { collection: NEW, typed: { kind: 'idea' } })).kept_as_note).toBeUndefined();
  });
});

describe('untypeCollection', () => {
  it('lists, then turns earlier typed copies into notes, leaving published and others\' memories alone', async () => {
    const C2 = 'private-legacy';
    const own = await storeMemory('legacy finding about acme', { collection: C2, typed: { kind: 'finding' } });
    const long = await storeMemory(`legacy decision ${'with a long body '.repeat(200)}`, { collection: C2, typed: { kind: 'decision', status: 'accepted', task_ids: ['tester-9'] } });
    const published = await putExternal(C2, 'rec:F-1', { content: 'F-1: published finding', typed: { kind: 'finding' } });
    await addDocument(C2, 'mem-sam-1', 'a teammate\'s question', { type: 'memory', username: 'sam', kind: 'question', status: 'open', created_at: 1 });
    await expect(untypeCollection(C2, { dryRun: true })).rejects.toThrow(/not marked/);
    await editScopeSettings({ op: 'add_records_elsewhere', collection: C2 });

    const dry = await untypeCollection(C2, { dryRun: true });
    expect(dry.items.map(i => i.id).sort()).toEqual([own.ids[0], long.ids[0].replace(/-0$/, '')].sort());
    expect(dry.by_kind).toEqual({ finding: 1, decision: 1 });
    expect(dry.others).toBe(1);
    expect((await meta(own.ids[0], C2)).kind).toBe('finding');

    const done = await untypeCollection(C2);
    expect(done.items).toHaveLength(2);
    const m = await meta(own.ids[0], C2);
    expect(m.kind).toBeUndefined();
    expect(m.status).toBeUndefined();
    expect((await getDocumentsByIds(C2, [own.ids[0]]))[0].content).toMatch(/typed fields removed \(was a finding, open\)/);
    const chunks = await getDocumentsByFilter(C2, { parent_id: long.ids[0].replace(/-0$/, '') }, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.metadata.kind).toBeUndefined();
      expect(c.metadata.task_ids).toEqual(['tester-9']);
    }
    expect((await meta(published.id, C2)).kind).toBe('finding');
    expect((await meta('mem-sam-1', C2)).kind).toBe('question');
    expect((await untypeCollection(C2, { dryRun: true })).items).toEqual([]);
  });
});
