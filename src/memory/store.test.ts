import { describe, expect, it } from 'vitest';
import { findConflicts } from './store.js';

const candidate = (id: string, distance: number, content: string, salience = 1.0) => ({
  id,
  content,
  distance,
  metadata: { salience },
});

describe('findConflicts', () => {
  it('returns empty when no candidates are below the threshold', () => {
    const out = findConflicts(
      [candidate('a', 0.40, 'unrelated'), candidate('b', 0.55, 'also unrelated')],
      0.25,
    );
    expect(out).toEqual([]);
  });

  it('returns a candidate when its distance is below the threshold', () => {
    const out = findConflicts([candidate('a', 0.10, 'duplicate-ish')], 0.25);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
    expect(out[0].distance).toBe(0.10);
  });

  it('truncates long content to 200 chars + ellipsis', () => {
    const longContent = 'x'.repeat(500);
    const out = findConflicts([candidate('a', 0.05, longContent)], 0.25);
    expect(out[0].content.length).toBe(201);
    expect(out[0].content.endsWith('…')).toBe(true);
  });

  it('sorts by distance ascending and caps at maxResults', () => {
    const out = findConflicts(
      [
        candidate('a', 0.20, 'a'),
        candidate('b', 0.05, 'b'),
        candidate('c', 0.10, 'c'),
        candidate('d', 0.15, 'd'),
      ],
      0.25,
      2,
    );
    expect(out.map(c => c.id)).toEqual(['b', 'c']);
  });

  it('defaults salience to 1.0 when missing from metadata', () => {
    const out = findConflicts(
      [{ id: 'a', content: 'x', distance: 0.05, metadata: {} }],
      0.25,
    );
    expect(out[0].salience).toBe(1.0);
  });
});
