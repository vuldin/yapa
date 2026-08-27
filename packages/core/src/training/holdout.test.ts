import { describe, expect, it } from 'vitest';
import { splitManifest } from './holdout.js';

function makeMemories(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `m-${i}`, content: `content ${i}` }));
}

describe('splitManifest', () => {
  it('is deterministic for a given manifest version', () => {
    const memories = makeMemories(20);
    const a = splitManifest(memories, 7);
    const b = splitManifest(memories, 7);
    expect(a.holdout.map(m => m.id)).toEqual(b.holdout.map(m => m.id));
    expect(a.train.map(m => m.id)).toEqual(b.train.map(m => m.id));
  });

  it('produces different splits for different manifest versions', () => {
    const memories = makeMemories(30);
    const a = splitManifest(memories, 1);
    const b = splitManifest(memories, 2);
    // With 30 memories and different seeds, at least one id should differ
    expect(a.holdout.map(m => m.id)).not.toEqual(b.holdout.map(m => m.id));
  });

  it('respects the configured fraction', () => {
    const memories = makeMemories(100);
    const { train, holdout } = splitManifest(memories, 1, 0.2, 0);
    expect(holdout.length).toBe(20);
    expect(train.length).toBe(80);
  });

  it('enforces a minimum holdout size', () => {
    const memories = makeMemories(10);
    const { holdout } = splitManifest(memories, 1, 0.05, 3); // raw would be 1, min is 3
    expect(holdout.length).toBe(3);
  });

  it('keeps at least one memory in train', () => {
    const memories = makeMemories(2);
    const { train, holdout } = splitManifest(memories, 1, 1.0, 0); // would ask for all
    expect(train.length).toBeGreaterThanOrEqual(1);
    expect(holdout.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty splits for empty input', () => {
    const { train, holdout } = splitManifest([], 1);
    expect(train).toEqual([]);
    expect(holdout).toEqual([]);
  });

  it('is a proper partition (no overlap, no loss)', () => {
    const memories = makeMemories(50);
    const { train, holdout } = splitManifest(memories, 42);
    const ids = new Set([...train.map(m => m.id), ...holdout.map(m => m.id)]);
    expect(ids.size).toBe(50);
    // No duplicates
    const holdoutIds = new Set(holdout.map(m => m.id));
    for (const t of train) expect(holdoutIds.has(t.id)).toBe(false);
  });
});
