import { describe, it, expect, vi } from 'vitest';
import { captureTurn, type CaptureDeps } from './capture.js';

const options = { maxMemories: 3, maxSalience: 2, dedupeDistance: 0.25 };
const input = { collection: 'project-acme', sessionId: 's1', turn: 4, userText: 'what port?', assistantText: 'It moved to 9000.' };

function deps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
    followThrough: vi.fn(async () => ({ judged: 0, changes: [] })) as any,
    extractMemories: vi.fn(async () => [{ content: 'acme API listens on port 9000', tags: ['ports'], salience: 4, sector: 'semantic', rationale: 'config' }]) as any,
    queryDocuments: vi.fn(async () => []) as any,
    resolveConflict: vi.fn() as any,
    storeMemory: vi.fn(async () => ({ ids: ['m1'], potential_conflicts: [] })) as any,
    log: vi.fn(),
    ...overrides,
  };
}

describe('captureTurn', () => {
  it('stores a fresh finding clamped, tagged and attributed', async () => {
    const d = deps();
    const result = await captureTurn(input, options, d);
    expect(result).toMatchObject({ stored: 1, skipped: 0 });
    expect(result.notice).toContain('project-acme');
    const [content, opts] = vi.mocked(d.storeMemory).mock.calls[0] as any;
    expect(content).toBe('acme API listens on port 9000');
    expect(opts.salience).toBe(2); // clamped from 4
    expect(opts.tags).toEqual(['ports', 'auto-capture']);
    expect(opts.metadata).toMatchObject({ source: 'auto-capture', session_id: 's1', turn: 4 });
  });

  it('supersedes a stale neighbor when the resolver says the fact changed', async () => {
    const d = deps({
      queryDocuments: vi.fn(async () => [{ id: 'old', content: 'acme API on port 8000', distance: 0.1, metadata: {} }]) as any,
      resolveConflict: vi.fn(async () => ({ action: 'supersede', targetId: 'old', mergedContent: 'acme API moved 8000 -> 9000', rationale: 'changed' })) as any,
    });
    const result = await captureTurn(input, options, d);
    expect(result.superseded).toBe(1);
    const [content, opts] = vi.mocked(d.storeMemory).mock.calls[0] as any;
    expect(content).toBe('acme API moved 8000 -> 9000');
    expect(opts.supersedes).toBe('old');
  });

  it('falls back to a strict distance gate when the resolver is down', async () => {
    const d = deps({
      queryDocuments: vi.fn(async () => [{ id: 'dup', content: 'same', distance: 0.05, metadata: {} }]) as any,
      resolveConflict: vi.fn(async () => { throw new Error('llm down'); }) as any,
    });
    const result = await captureTurn(input, options, d);
    expect(result).toMatchObject({ stored: 0, skipped: 1 });
    expect(d.storeMemory).not.toHaveBeenCalled();
  });

  it('ignores archived neighbors and does nothing when extraction finds nothing', async () => {
    const empty = deps({ extractMemories: vi.fn(async () => []) as any });
    expect(await captureTurn(input, options, empty)).toEqual({ stored: 0, skipped: 0, superseded: 0 });
  });

  it('stores a typed candidate (a decision as made) linked to the session\'s task, and never replaces a typed memory', async () => {
    const d = deps({
      extractMemories: vi.fn(async () => [{ content: 'We use a shared cache', tags: [], salience: 2, sector: 'episodic', rationale: 'decided', kind: 'decision' }]) as any,
    });
    await captureTurn(input, { ...options, taskIds: ['t-7'] }, d);
    const [, opts] = vi.mocked(d.storeMemory).mock.calls[0] as any;
    expect(opts.typed).toEqual({ kind: 'decision', status: 'accepted', task_ids: ['t-7'] });

    const typedNeighbor = deps({
      queryDocuments: vi.fn(async () => [{ id: 'dec', content: 'shared cache', distance: 0.1, metadata: { kind: 'decision', status: 'needed' } }]) as any,
      resolveConflict: vi.fn(async () => ({ action: 'supersede', targetId: 'dec', mergedContent: 'x', rationale: 'r' })) as any,
    });
    const r = await captureTurn(input, options, typedNeighbor);
    expect(r).toMatchObject({ stored: 0, skipped: 1, superseded: 0 });
    expect(typedNeighbor.storeMemory).not.toHaveBeenCalled();
  });
});
