import { describe, expect, it } from 'vitest';
import {
  author, buildWaiting, dueDate, formatWaiting, isOpenTyped, isUpcoming, itemContent, joinBounded, MAX_ITEM_CONTENT_BYTES, MAX_RESULT_BYTES,
  needsPersonText, opensAt, truncateBytes, typedLabel, waitingCount, waitsOnText,
} from './format.js';
import type { DocRow } from './queries.js';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('truncation', () => {
  it('leaves short content alone', () => {
    expect(truncateBytes('hello', 10)).toBe('hello');
  });

  it('caps item content at 4 KiB without splitting multi-byte characters', () => {
    const s = 'é'.repeat(5000) + '🙂'.repeat(10);
    const out = itemContent(s);
    expect(bytes(out)).toBeLessThanOrEqual(MAX_ITEM_CONTENT_BYTES);
    expect(out.endsWith('…[truncated]')).toBe(true);
    expect(out).not.toContain('�');
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('caps a whole result at 64 KiB, keeps the footer and says how much was omitted', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => `item ${i} ${'x'.repeat(3000)}`);
    const out = joinBounded(blocks, '\n', ['cursor: abc']);
    expect(bytes(out)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(out).toMatch(/…\[\d+ more item\(s\) omitted: result size limit\]/);
    expect(out.endsWith('cursor: abc')).toBe(true);
    expect(out).toContain('item 0 ');
  });

  it('joins everything when it fits', () => {
    expect(joinBounded(['a', 'b'], '\n')).toBe('a\nb');
  });
});

describe('labels', () => {
  it('attributes rows to their author and last editor', () => {
    expect(author({ origin_user: 'alice', last_editor: null })).toBe('by alice');
    expect(author({ origin_user: 'alice', last_editor: 'alice' })).toBe('by alice');
    expect(author({ origin_user: 'alice', last_editor: 'bob' })).toBe('by alice, edited by bob');
  });

  it('treats due_date 0 as unset', () => {
    expect(dueDate({ due_date: 0 })).toBeUndefined();
    expect(dueDate({ due_date: 1_791_000_000 })).toBe('2026-10-03');
  });
});

describe('typed memories', () => {
  it('labels like core: kind, status (or the kind default), and "for <owner>" only for decisions and questions', () => {
    expect(typedLabel({ kind: 'decision', status: 'needed', owner: 'alice' })).toBe('[decision, needed, for alice]');
    expect(typedLabel({ kind: 'decision' })).toBe('[decision, proposed]');
    expect(typedLabel({ kind: 'question', owner: 'alex' })).toBe('[question, open, for alex]');
    expect(typedLabel({ kind: 'finding', status: 'resolved', owner: 'alice' })).toBe('[finding, resolved]');
    expect(typedLabel({ kind: 'idea' })).toBe('[idea, proposed]');
    expect(typedLabel({ type: 'memory' })).toBe('');
    expect(typedLabel({ kind: 'nonsense', status: 'open' })).toBe('');
  });

  it('open statuses per kind', () => {
    expect(isOpenTyped({ kind: 'decision', status: 'needed' })).toBe(true);
    expect(isOpenTyped({ kind: 'decision', status: 'accepted' })).toBe(false);
    expect(isOpenTyped({ kind: 'limitation', status: 'mitigated' })).toBe(false);
    expect(isOpenTyped({ kind: 'question' })).toBe(true);
    expect(isOpenTyped({ status: 'open' })).toBe(false);
  });

  it('task flags: needs a person (names or anyone) and waits on', () => {
    expect(needsPersonText({ tags: ['needs-human'] })).toBe('needs a person (anyone)');
    expect(needsPersonText({ tags: 'needs-human,needs:alex' })).toBe('needs a person (alex)');
    expect(needsPersonText({ tags: ['needs:alex', 'needs:sam', 'auto'] })).toBe('needs a person (alex, sam)');
    expect(needsPersonText({ tags: ['auto'] })).toBeUndefined();
    expect(waitsOnText({ waits_on: ['m-1', 'm-2'] })).toBe('waits on m-1, m-2');
    expect(waitsOnText({ waits_on: 'm-1' })).toBe('waits on m-1');
    expect(waitsOnText({})).toBeUndefined();
  });
});

describe('waiting', () => {
  const NOW = 1_800_000_000;
  const row = (id: string, content: string, metadata: Record<string, any>, extra: Partial<DocRow> = {}): DocRow => ({
    id, collection: 'project-x', content, metadata, origin_user: 'alice', last_editor: null, created_at: NOW - 10 * 86400, updated_at: NOW - 3 * 86400, ...extra,
  });
  const memories = [
    row('d-1', '# Batch size\nmore text', { type: 'memory', kind: 'decision', status: 'needed', owner: 'alice', options: ['1, simplest', '64'], recommendation: '64' }),
    row('d-2', 'Anyone may choose', { type: 'memory', kind: 'decision' }, { updated_at: NOW - 2 * 3600 }),
    row('d-3', 'Decided already', { type: 'memory', kind: 'decision', status: 'accepted' }),
    row('d-4', 'For someone else', { type: 'memory', kind: 'decision', status: 'proposed', owner: 'sam' }),
    row('d-5', 'Archived', { type: 'memory', kind: 'decision', status: 'needed', archived: true }),
    row('q-1-0', 'Which region?', { type: 'memory', kind: 'question', owner: 'alice', parent_id: 'q-1', chunk_index: 0 }, { updated_at: NOW - 60 }),
    row('q-1-1', 'second chunk', { type: 'memory', kind: 'question', owner: 'alice', parent_id: 'q-1', chunk_index: 1 }),
    row('q-2', 'Answered', { type: 'memory', kind: 'question', status: 'answered' }),
  ];
  const tasks = [
    row('alice-1', 'Rerun the bench', { type: 'task', status: 'pending', waits_on: ['d-1'] }),
    row('alice-2', 'Approve the budget', { type: 'task', status: 'pending', tags: ['needs:alice'] }, { updated_at: NOW - 5 * 86400 }),
    row('alice-3', 'Any person step', { type: 'task', status: 'in_progress', tags: ['needs-human'] }),
    row('sam-1', 'Sam signs off', { type: 'task', status: 'pending', tags: ['needs:sam'] }, { origin_user: 'sam' }),
    row('alice-4', 'Stuck on access', { type: 'task', status: 'blocked', blockedReason: 'no VPN' }),
    row('sam-2', 'Sam is stuck', { type: 'task', status: 'blocked' }, { origin_user: 'sam' }),
    row('alice-5', 'Done', { type: 'task', status: 'complete', tags: ['needs-human'] }),
  ];

  it('builds core\'s sections for the caller (or anyone), oldest first, with waiting tasks', () => {
    const w = buildWaiting(memories, tasks, 'alice');
    expect(w.decisions.map(i => i.id)).toEqual(['d-1', 'd-2']);
    expect(w.decisions[0]).toMatchObject({ for: ['alice'], options: ['1, simplest', '64'], recommendation: '64', waiting_tasks: ['alice-1'], title: 'Batch size' });
    expect(w.questions.map(i => i.id)).toEqual(['q-1']);
    expect(w.questions[0].title).toBe('Which region?');
    expect(w.actions.map(i => i.id)).toEqual(['alice-2', 'alice-3']);
    expect(w.blocked.map(i => i.id)).toEqual(['alice-4']);
    expect(waitingCount(w)).toBe(6);
  });

  it('"everyone" keeps every item; a memory status never counts as a task status', () => {
    const w = buildWaiting(memories, tasks);
    expect(w.decisions.map(i => i.id)).toEqual(['d-1', 'd-4', 'd-2']);
    expect(w.actions.map(i => i.id).sort()).toEqual(['alice-2', 'alice-3', 'sam-1']);
    expect(w.blocked.map(i => i.id).sort()).toEqual(['alice-4', 'sam-2']);
    // Rows of the wrong type are ignored even if they look like the other kind.
    const mixed = buildWaiting([row('t-x', 'task', { type: 'task', kind: 'decision', status: 'needed' })], [row('m-x', 'memory', { type: 'memory', status: 'blocked' })]);
    expect(waitingCount(mixed)).toBe(0);
  });

  it('formats exactly like core\'s formatWaiting', () => {
    const text = formatWaiting(buildWaiting(memories, tasks, 'alice'), { collection: true, now: NOW });
    expect(text).toBe([
      '## Decisions (2)',
      '- **d-1** (project-x) [decision needed, for alice, 3d] Batch size',
      '  options: 1, simplest | 64; recommended: 64; waiting: alice-1',
      '- **d-2** (project-x) [decision proposed, for anyone, 2h] Anyone may choose',
      '',
      '## Questions (1)',
      '- **q-1** (project-x) [question, for alice, new] Which region?',
      '',
      '## Steps only a person can take (2)',
      '- **alice-2** (project-x) [needs a person, for alice, 5d] Approve the budget',
      '- **alice-3** (project-x) [needs a person, for anyone, 3d] Any person step',
      '',
      '## Blocked (1)',
      '- **alice-4** (project-x) [blocked, for alice, 3d] Stuck on access',
      '  reason: no VPN',
    ].join('\n'));
    expect(formatWaiting(buildWaiting([], []))).toBe('Nothing is waiting on anyone.');
  });

  it('matches owners case-insensitively, and gives an outside owner\'s item to whoever recorded it', () => {
    const mems = [
      row('q-a', 'Which plan?', { type: 'memory', kind: 'question', owner: 'Alice' }),
      row('q-e', 'Can the vendor raise the limit?', { type: 'memory', kind: 'question', owner: 'Vendor support' }, { origin_user: 'sam' }),
    ];
    const w = buildWaiting(mems, tasks, 'ALICE', 'alice');
    expect(w.questions.map(i => [i.id, i.for, i.ask])).toEqual([['q-a', ['alice'], undefined]]);
    const sam = buildWaiting(mems, tasks, 'sam', 'sam');
    expect(sam.questions.map(i => [i.id, i.for, i.ask])).toEqual([['q-e', ['sam'], 'Vendor support']]);
    expect(formatWaiting(sam, { now: NOW })).toContain('- **q-e** [question, for sam, ask Vendor support, 3d] Can the vendor raise the limit?');
  });
});

describe('upcoming recurring tasks', () => {
  const due = 2_000_000_000;
  const rec = (extra: Record<string, unknown> = {}) => ({ type: 'task', status: 'pending', is_recurring: true, recurrence_pattern: 'weekly', due_date: due, ...extra });

  it('open at the start of the due day, lead_days earlier (default by pattern)', () => {
    expect(opensAt(rec())).toBe(due - 86399 - 2 * 86400);
    expect(opensAt(rec({ lead_days: 0 }))).toBe(due - 86399);
    expect(opensAt(rec({ recurrence_pattern: 'yearly' }))).toBe(due - 86399 - 30 * 86400);
    expect(opensAt({ type: 'task', due_date: due })).toBeUndefined();
    // A stored opens_at that fits the due date is used; a stale one isn't.
    expect(opensAt(rec({ opens_at: due - 2 * 86400 - 5 * 3600 }))).toBe(due - 2 * 86400 - 5 * 3600);
    expect(opensAt(rec({ opens_at: due - 20 * 86400 }))).toBe(due - 86399 - 2 * 86400);
  });

  it('only a pending recurring occurrence with a due date is upcoming', () => {
    const before = due - 86399 - 2 * 86400 - 1;
    expect(isUpcoming(rec(), before)).toBe(true);
    expect(isUpcoming(rec(), before + 1)).toBe(false);
    expect(isUpcoming(rec({ status: 'blocked' }), before)).toBe(false);
    expect(isUpcoming(rec({ is_recurring: false }), before)).toBe(false);
    expect(isUpcoming(rec({ due_date: 0 }), before)).toBe(false);
    expect(isUpcoming(rec({ recurrence_pattern: 'hourly' }), before)).toBe(false);
  });
});
