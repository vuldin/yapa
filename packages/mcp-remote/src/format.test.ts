import { describe, expect, it } from 'vitest';
import { author, dueDate, itemContent, joinBounded, MAX_ITEM_CONTENT_BYTES, MAX_RESULT_BYTES, truncateBytes } from './format.js';

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
