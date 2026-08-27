import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the core before importing the plugin modules that use it.
// (vi.hoisted: the vi.mock factory is hoisted above plain const declarations.)
const { extractMemories, queryDocuments, storeMemory, resolveConflict } = vi.hoisted(() => ({
  extractMemories: vi.fn(),
  queryDocuments: vi.fn(),
  storeMemory: vi.fn(),
  resolveConflict: vi.fn(),
}));

vi.mock('@yapa/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@yapa/core')>();
  return {
    ...actual,
    setConfig: vi.fn(),
    getConfig: vi.fn(() => actual.createConfig({})),
    listCollections: vi.fn(async () => []),
    extractMemories,
    queryDocuments,
    storeMemory,
    resolveConflict,
    // Stale dist lacks these until core is rebuilt; pin them in the mock.
    RESOLVER_PROMPT_VERSION: 'v1',
    EXTRACTOR_PROMPT_VERSION: 'v1',
  };
});

import { registerResponseCapture, takeCaptureNotice, whenCapturesIdle } from './response-capture.js';
import { resolveConfig, type ResolvedConfig } from './config.js';

type Listener = (...args: any[]) => void;

function makeCtx(resolved: ResolvedConfig) {
  const listeners = new Map<string, Listener>();
  const ctx = {
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  };
  registerResponseCapture(ctx as any, () => resolved);
  return { listeners };
}

const session = { id: 's1', header: { cwd: '/home/vuldin/projects/acme' } };

function driveTurn(listeners: Map<string, Listener>, opts: { userText?: string; assistantText?: string; reason?: string } = {}) {
  const fire = (type: string, data: unknown) => listeners.get('session/event')?.(session, { type, data });
  fire('turn/start', { turn: 1 });
  if (opts.userText !== undefined) {
    fire('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: opts.userText }],
    });
  }
  if (opts.assistantText !== undefined) {
    fire('assistant/message', {
      turn: 1, step: 1,
      message: { content: [{ type: 'text', text: opts.assistantText }] },
    });
  }
  fire('turn/end', { turn: 1, reason: { kind: opts.reason ?? 'completed' } });
}

const resolved = resolveConfig({ projectRoots: ['/home/vuldin/projects'] });
const longText = 'x'.repeat(300);

describe('response capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryDocuments.mockResolvedValue([]);
    storeMemory.mockResolvedValue({ ids: ['mem-new-1'], potential_conflicts: [] });
    extractMemories.mockResolvedValue([
      { content: 'The FD codec requires 8-byte alignment.', tags: ['codec'], sector: 'semantic', salience: 3, rationale: 'non-obvious' },
    ]);
  });

  it('extracts and stores a novel candidate with clamped salience and provenance', async () => {
    const { listeners } = makeCtx(resolved);
    driveTurn(listeners, { userText: longText, assistantText: longText });
    await whenCapturesIdle();

    expect(extractMemories).toHaveBeenCalledOnce();
    const input = extractMemories.mock.calls[0][0];
    expect(input.collection).toBe('project-acme');
    expect(input.userText).toBe(longText);

    expect(storeMemory).toHaveBeenCalledOnce();
    const [content, opts] = storeMemory.mock.calls[0];
    expect(content).toContain('8-byte alignment');
    expect(opts.collection).toBe('project-acme');
    expect(opts.salience).toBe(2); // clamped from 3 to captureMaxSalience
    expect(opts.tags).toContain('auto-capture');
    expect(opts.tags).toContain('codec');
    expect(opts.metadata).toMatchObject({ source: 'auto-capture', session_id: 's1', turn: 1 });
  });

  it('skips candidates the resolver judges already known', async () => {
    queryDocuments.mockResolvedValue([
      { id: 'mem-old', content: 'FD codec alignment is 8 bytes.', distance: 0.1, metadata: { salience: 2 } },
    ]);
    resolveConflict.mockResolvedValue({ action: 'skip', rationale: 'same fact' });
    const { listeners } = makeCtx(resolved);
    driveTurn(listeners, { userText: longText, assistantText: longText });
    await whenCapturesIdle();

    expect(resolveConflict).toHaveBeenCalledOnce();
    expect(storeMemory).not.toHaveBeenCalled();
    expect(takeCaptureNotice('s1')).toContain('skipped as already known');
  });

  it('supersedes a stale memory when the resolver says the fact changed', async () => {
    queryDocuments.mockResolvedValue([
      { id: 'mem-old', content: 'FD codec alignment is 4 bytes.', distance: 0.12, metadata: { salience: 2 } },
    ]);
    resolveConflict.mockResolvedValue({
      action: 'supersede',
      targetId: 'mem-old',
      mergedContent: 'The FD codec requires 8-byte alignment (previously 4).',
      rationale: 'value changed',
    });
    const { listeners } = makeCtx(resolved);
    driveTurn(listeners, { userText: longText, assistantText: longText });
    await whenCapturesIdle();

    expect(storeMemory).toHaveBeenCalledOnce();
    const [content, opts] = storeMemory.mock.calls[0];
    expect(content).toBe('The FD codec requires 8-byte alignment (previously 4).');
    expect(opts.supersedes).toBe('mem-old');
    expect(opts.metadata.resolver_rationale).toBe('value changed');
    expect(takeCaptureNotice('s1')).toContain('superseding stale memory');
  });

  it('stores when the resolver fails and the neighbor is only loosely similar', async () => {
    // 0.2 is inside the resolver gate (0.25) but outside the strict fallback
    // gate (0.125) — a resolver outage must not lose genuinely novel facts.
    queryDocuments.mockResolvedValue([
      { id: 'mem-old', content: 'similar', distance: 0.2, metadata: {} },
    ]);
    resolveConflict.mockRejectedValue(new Error('aux route down'));
    const { listeners } = makeCtx(resolved);
    driveTurn(listeners, { userText: longText, assistantText: longText });
    await whenCapturesIdle();

    expect(storeMemory).toHaveBeenCalledOnce();
    expect(storeMemory.mock.calls[0][1].supersedes).toBeUndefined();
  });

  it('skips when the resolver fails and the neighbor is a near-exact duplicate', async () => {
    // 0.05 < strict fallback (0.125): blind-storing here would double-store
    // facts the agent captured mid-turn itself.
    queryDocuments.mockResolvedValue([
      { id: 'mem-old', content: 'same fact', distance: 0.05, metadata: {} },
    ]);
    resolveConflict.mockRejectedValue(new Error('aux route down'));
    const { listeners } = makeCtx(resolved);
    driveTurn(listeners, { userText: longText, assistantText: longText });
    await whenCapturesIdle();

    expect(storeMemory).not.toHaveBeenCalled();
  });

  it('sets a visibility notice consumed exactly once', async () => {
    const { listeners } = makeCtx(resolved);
    driveTurn(listeners, { userText: longText, assistantText: longText });
    await whenCapturesIdle();

    expect(takeCaptureNotice('s1')).toContain('Auto-captured 1 memory');
    expect(takeCaptureNotice('s1')).toBeUndefined();
  });

  it('prefilter skips trivially short turns without an LLM call', async () => {
    const { listeners } = makeCtx(resolved);
    driveTurn(listeners, { userText: 'hi', assistantText: 'Hello!' });
    await whenCapturesIdle();
    expect(extractMemories).not.toHaveBeenCalled();
  });

  it('ignores blocked turns', async () => {
    const { listeners } = makeCtx(resolved);
    driveTurn(listeners, { userText: longText, assistantText: longText, reason: 'blocked' });
    await whenCapturesIdle();
    expect(extractMemories).not.toHaveBeenCalled();
  });

  it('ignores user-role messages that are not human-sourced', async () => {
    const { listeners } = makeCtx(resolved);
    const fire = (type: string, data: unknown) => listeners.get('session/event')?.(session, { type, data });
    fire('turn/start', { turn: 1 });
    fire('user/message', { source: { kind: 'plugin', plugin: 'yapa' }, content: [{ type: 'text', text: 'INJECTED CONTEXT' }] });
    fire('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: longText }] } });
    fire('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await whenCapturesIdle();

    expect(extractMemories).toHaveBeenCalledOnce();
    expect(extractMemories.mock.calls[0][0].userText).not.toContain('INJECTED CONTEXT');
  });

  it('does nothing when captureResponses is disabled', async () => {
    const off = resolveConfig({ projectRoots: ['/home/vuldin/projects'], captureResponses: false });
    const { listeners } = makeCtx(off);
    driveTurn(listeners, { userText: longText, assistantText: longText });
    await whenCapturesIdle();
    expect(extractMemories).not.toHaveBeenCalled();
  });

  it('fails open when extraction throws', async () => {
    extractMemories.mockRejectedValue(new Error('aux route down'));
    const { listeners } = makeCtx(resolved);
    expect(() => driveTurn(listeners, { userText: longText, assistantText: longText })).not.toThrow();
    await whenCapturesIdle();
    expect(storeMemory).not.toHaveBeenCalled();
  });

  it('cleans up buffers on session disposal', async () => {
    const { listeners } = makeCtx(resolved);
    const fire = (type: string, data: unknown) => listeners.get('session/event')?.(session, { type, data });
    fire('turn/start', { turn: 1 });
    listeners.get('session/disposed')?.(session);
    fire('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: longText }] } });
    fire('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await whenCapturesIdle();
    expect(extractMemories).not.toHaveBeenCalled();
  });
});
