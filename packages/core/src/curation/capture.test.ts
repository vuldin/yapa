import { describe, it, expect, vi } from 'vitest';
import { captureTurn, type CaptureDeps } from './capture.js';

const options = { maxMemories: 3, maxSalience: 2, dedupeDistance: 0.25 };
const input = { collection: 'project-acme', sessionId: 's1', turn: 4, userText: 'what port?', assistantText: 'It moved to 9000.' };

function deps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
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
});
