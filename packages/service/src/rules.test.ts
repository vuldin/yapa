import { describe, expect, it } from 'vitest';
import {
  changedKeys, checkCollection, checkDocId, checkEmbedding, checkUpsertItem, classifyUpdate, isLocalOnlyCollection,
  taskIdPrefix, violatesTaskNamespace,
} from './rules.js';

export function unitVector(seed = 1, dims = 384): number[] {
  const v = Array.from({ length: dims }, (_, i) => Math.sin(seed * (i + 1)));
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

describe('collections', () => {
  it('local-only classes', () => {
    for (const c of ['global', 'private-notes', 'local-scratch']) expect(isLocalOnlyCollection(c)).toBe(true);
    for (const c of ['customer-acme', 'project-yapa', 'globalish', 'privateer']) expect(isLocalOnlyCollection(c)).toBe(false);
  });

  it('checkCollection', () => {
    expect(checkCollection('customer-acme')).toEqual({ ok: true });
    expect(checkCollection('global')).toMatchObject({ ok: false, code: 'local_only_collection' });
    expect(checkCollection('private-x')).toMatchObject({ ok: false, code: 'local_only_collection' });
    expect(checkCollection('Customer')).toMatchObject({ ok: false, code: 'invalid_collection' });
    expect(checkCollection('-x')).toMatchObject({ ok: false, code: 'invalid_collection' });
    expect(checkCollection('a'.repeat(129))).toMatchObject({ ok: false, code: 'invalid_collection' });
    expect(checkCollection(5)).toMatchObject({ ok: false, code: 'invalid_collection' });
  });
});

describe('ids', () => {
  it('checkDocId', () => {
    expect(checkDocId('acme-auth-fix-1')).toBeUndefined();
    expect(checkDocId('__sync_deletes__')).toMatch(/sentinel/);
    expect(checkDocId('')).toBeDefined();
    expect(checkDocId('a b')).toBeDefined();
    expect(checkDocId('x'.repeat(201))).toBeDefined();
  });

  it('task namespace', () => {
    expect(taskIdPrefix('alice-12')).toBe('alice');
    expect(taskIdPrefix('a-b-12')).toBe('a-b');
    expect(taskIdPrefix('acme-notes')).toBeUndefined();
    // Tasks must be <caller>-<n>.
    expect(violatesTaskNamespace('alice-12', true, 'alice', false)).toBe(false);
    expect(violatesTaskNamespace('bob-12', true, 'alice', true)).toBe(true);
    expect(violatesTaskNamespace('nobody-3', true, 'alice', false)).toBe(true);
    expect(violatesTaskNamespace('alice-notes', true, 'alice', false)).toBe(true);
    // Non-task docs may end in digits, but not squat another user's namespace.
    expect(violatesTaskNamespace('acme-auth-fix-1', false, 'alice', false)).toBe(false);
    expect(violatesTaskNamespace('bob-99', false, 'alice', true)).toBe(true);
  });
});

describe('embeddings', () => {
  it('accepts a 384-d unit vector', () => {
    expect(checkEmbedding(unitVector()).ok).toBe(true);
  });
  it('rejects wrong dimensions', () => {
    expect(checkEmbedding(unitVector(1, 768))).toMatchObject({ ok: false, code: 'embedding_dimension' });
    expect(checkEmbedding([])).toMatchObject({ ok: false, code: 'embedding_dimension' });
  });
  it('rejects non-finite and non-numeric values', () => {
    const v = unitVector();
    v[3] = NaN;
    expect(checkEmbedding(v)).toMatchObject({ ok: false, code: 'embedding_invalid' });
    const w: unknown[] = unitVector();
    w[0] = '0.1';
    expect(checkEmbedding(w)).toMatchObject({ ok: false, code: 'embedding_invalid' });
    expect(checkEmbedding('nope')).toMatchObject({ ok: false, code: 'embedding_invalid' });
  });
  it('rejects non-normalized vectors, tolerating 1%', () => {
    expect(checkEmbedding(unitVector().map(x => x * 2))).toMatchObject({ ok: false, code: 'embedding_invalid' });
    expect(checkEmbedding(unitVector().map(x => x * 1.005)).ok).toBe(true);
    expect(checkEmbedding(new Array(384).fill(0))).toMatchObject({ ok: false, code: 'embedding_invalid' });
  });
});

describe('checkUpsertItem', () => {
  const now = 1_760_000_000;
  const good = { id: 'alice-1', collection: 'project-yapa', content: 'hi', embedding: unitVector(), metadata: { type: 'task' }, created_at: now - 10, updated_at: now };

  it('accepts a valid item', () => {
    expect(checkUpsertItem(good, now)).toMatchObject({ ok: true, doc: { id: 'alice-1', created_at: now - 10 } });
  });
  it('checks the collection class first', () => {
    expect(checkUpsertItem({ ...good, collection: 'global', embedding: 'bad' }, now)).toMatchObject({ ok: false, code: 'local_only_collection' });
  });
  it('bounds created_at', () => {
    expect(checkUpsertItem({ ...good, created_at: 1_600_000_000 }, now)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(checkUpsertItem({ ...good, created_at: now + 2 * 86400 }, now)).toMatchObject({ ok: false, code: 'invalid_request' });
  });
  it('enforces sizes', () => {
    expect(checkUpsertItem({ ...good, content: 'x'.repeat(65 * 1024) }, now)).toMatchObject({ ok: false, code: 'payload_too_large' });
    expect(checkUpsertItem({ ...good, metadata: { big: 'x'.repeat(33 * 1024) } }, now)).toMatchObject({ ok: false, code: 'payload_too_large' });
  });
  it('rejects journal drafts and missing embeddings', () => {
    expect(checkUpsertItem({ ...good, metadata: { type: 'journal_draft' } }, now)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(checkUpsertItem({ ...good, embedding: undefined }, now)).toMatchObject({ ok: false, code: 'embedding_invalid' });
  });
});

describe('audit classification', () => {
  it('classifyUpdate', () => {
    expect(classifyUpdate({ collection: 'a', metadata: {} }, { collection: 'b', metadata: {} })).toBe('move');
    expect(classifyUpdate({ collection: 'a', metadata: {} }, { collection: 'a', metadata: { archived: true } })).toBe('archive');
    expect(classifyUpdate({ collection: 'a', metadata: {} }, { collection: 'a', metadata: { superseded_by: 'x' } })).toBe('archive');
    expect(classifyUpdate({ collection: 'a', metadata: { archived: true } }, { collection: 'a', metadata: { archived: true, n: 1 } })).toBe('update');
  });
  it('changedKeys', () => {
    expect(changedKeys({ a: 1, b: 2, c: [1] }, { a: 1, b: 3, d: 4, c: [1] })).toEqual(['b', 'd']);
  });
});
